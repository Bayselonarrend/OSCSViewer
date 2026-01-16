import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface LineStat {
    count: number;
    time: number;
}

interface FunctionStats {
    [line: string]: LineStat;
}

interface FileStats {
    '#path': string;
    [func: string]: FunctionStats | string;
}

interface CodeStatData {
    [filePath: string]: FileStats;
}

interface StatFile {
    path: string;
    enabled: boolean;
}

let statFiles: StatFile[] = [];
let perFileStats: Map<string, Map<number, LineStat>>[] = []; // stats per each stat file
// Two decoration types per file: one for count, one for time
let countDecorationTypes: vscode.TextEditorDecorationType[] = [];
let timeDecorationTypes: vscode.TextEditorDecorationType[] = [];
let statusBarItem: vscode.StatusBarItem;

// Dynamic widths calculated from data
let maxCountWidth = 1;
let maxTimeWidth = 3;

// Hot lines provider
let hotLinesProvider: HotLinesProvider;
let currentFileProvider: CurrentFileHotLinesProvider;

interface HotLineInfo {
    filePath: string;
    fileName: string;
    line: number;
    funcName: string;
    count: number;
    time: number;
}

// Store raw data for hot lines
let rawCodeStatData: Map<string, CodeStatData> = new Map();

export function activate(context: vscode.ExtensionContext) {
    // Load saved state
    statFiles = context.workspaceState.get('codestatFiles', []);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(watch) CodeStat';
    statusBarItem.tooltip = 'Click to open CodeStat panel';
    statusBarItem.command = 'workbench.view.extension.codestat';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register tree data provider
    const treeProvider = new StatFilesProvider();
    vscode.window.registerTreeDataProvider('codestatFiles', treeProvider);

    // Register hot lines provider
    hotLinesProvider = new HotLinesProvider();
    vscode.window.registerTreeDataProvider('codestatHotLines', hotLinesProvider);

    // Register current file hot lines provider
    currentFileProvider = new CurrentFileHotLinesProvider();
    vscode.window.registerTreeDataProvider('codestatCurrentFile', currentFileProvider);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('codestat.refresh', () => {
            loadAllStats();
            updateAllDecorations();
            treeProvider.refresh();
            hotLinesProvider.refresh();
            currentFileProvider.refresh();
            vscode.window.showInformationMessage('CodeStat refreshed');
        }),

        vscode.commands.registerCommand('codestat.addFile', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: true,
                filters: { 'JSON/Text': ['json', 'txt'] },
                title: 'Select CodeStat files'
            });
            if (uris) {
                for (const uri of uris) {
                    if (!statFiles.find(f => f.path === uri.fsPath)) {
                        statFiles.push({ path: uri.fsPath, enabled: true });
                    }
                }
                saveState(context);
                loadAllStats();
                updateAllDecorations();
                treeProvider.refresh();
                currentFileProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('codestat.removeFile', (item: StatFileItem) => {
            statFiles = statFiles.filter(f => f.path !== item.statFile.path);
            saveState(context);
            loadAllStats();
            updateAllDecorations();
            treeProvider.refresh();
            hotLinesProvider.setSelectedFile(null);
            currentFileProvider.refresh();
        }),

        vscode.commands.registerCommand('codestat.toggleFile', (item: StatFileItem) => {
            const file = statFiles.find(f => f.path === item.statFile.path);
            if (file) {
                file.enabled = !file.enabled;
                saveState(context);
                loadAllStats();
                updateAllDecorations();
                treeProvider.refresh();
                hotLinesProvider.refresh();
                currentFileProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('codestat.selectFile', (item: StatFileItem) => {
            hotLinesProvider.setSelectedFile(item.statFile.path);
        }),

        vscode.commands.registerCommand('codestat.goToLine', (hotLine: HotLineInfo) => {
            const fullPath = hotLine.filePath;
            vscode.workspace.openTextDocument(fullPath).then(doc => {
                vscode.window.showTextDocument(doc).then(editor => {
                    const position = new vscode.Position(hotLine.line - 1, 0);
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                });
            }, () => {
                vscode.window.showWarningMessage(`File not found: ${fullPath}`);
            });
        }),

        vscode.commands.registerCommand('codestat.goToLineInCurrentFile', (line: number) => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const position = new vscode.Position(line - 1, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
        })
    );

    // Update decorations on editor change
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            updateDecorations(editor);
            currentFileProvider.refresh();
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document) {
            updateDecorations(editor);
        }
    }, null, context.subscriptions);

    // Initial load
    loadAllStats();
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
        currentFileProvider.refresh();
    }
}

function saveState(context: vscode.ExtensionContext) {
    context.workspaceState.update('codestatFiles', statFiles);
}

function createDecorationTypes() {
    // Dispose old decoration types
    for (const dt of countDecorationTypes) {
        dt.dispose();
    }
    for (const dt of timeDecorationTypes) {
        dt.dispose();
    }
    countDecorationTypes = [];
    timeDecorationTypes = [];

    // Create two decoration types per enabled file (count + time)
    const enabledFiles = statFiles.filter(f => f.enabled);
    for (let i = 0; i < enabledFiles.length; i++) {
        const countDt = vscode.window.createTextEditorDecorationType({
            before: {
                margin: '0 0 0 0',
                width: `${maxCountWidth + 2}ch`, // +2 for "× "
                color: new vscode.ThemeColor('editorCodeLens.foreground')
            }
        });
        const timeDt = vscode.window.createTextEditorDecorationType({
            before: {
                margin: '0 0.5ch 0 0',
                width: `${maxTimeWidth + 2}ch`, // +2 for separator
                color: new vscode.ThemeColor('editorCodeLens.foreground')
            }
        });
        countDecorationTypes.push(countDt);
        timeDecorationTypes.push(timeDt);
    }
}

function formatTime(time: number): string {
    if (time >= 1000) {
        return `${(time / 1000).toFixed(1)}s`;
    }
    return `${time}ms`;
}

function loadAllStats() {
    perFileStats = [];
    rawCodeStatData.clear();
    maxCountWidth = 1;
    maxTimeWidth = 3; // minimum "0ms"

    const enabledFiles = statFiles.filter(f => f.enabled);
    
    for (const statFile of enabledFiles) {
        const fileStatsMap: Map<string, Map<number, LineStat>> = new Map();

        try {
            const content = fs.readFileSync(statFile.path, 'utf-8');
            const data: CodeStatData = JSON.parse(content);
            
            // Store raw data for hot lines
            rawCodeStatData.set(statFile.path, data);

            for (const [filePath, fileStats] of Object.entries(data)) {
                const fileName = path.basename(filePath).toLowerCase();

                if (!fileStatsMap.has(fileName)) {
                    fileStatsMap.set(fileName, new Map());
                }
                const lineMap = fileStatsMap.get(fileName)!;

                for (const [key, value] of Object.entries(fileStats)) {
                    if (key === '#path') continue;

                    const funcStats = value as FunctionStats;
                    for (const [lineStr, stat] of Object.entries(funcStats)) {
                        const line = parseInt(lineStr);
                        const existing = lineMap.get(line);
                        if (existing) {
                            existing.count += stat.count;
                            existing.time += stat.time;
                        } else {
                            lineMap.set(line, { count: stat.count, time: stat.time });
                        }
                        
                        // Update max widths
                        const countStr = `${stat.count}`;
                        const timeStr = formatTime(stat.time);
                        maxCountWidth = Math.max(maxCountWidth, countStr.length);
                        maxTimeWidth = Math.max(maxTimeWidth, timeStr.length);
                    }
                }
            }
        } catch (e) {
            console.error(`Failed to load ${statFile.path}:`, e);
        }

        perFileStats.push(fileStatsMap);
    }

    createDecorationTypes();
    updateStatusBar();
}

function updateStatusBar() {
    const enabledCount = statFiles.filter(f => f.enabled).length;
    statusBarItem.text = `$(watch) CodeStat (${enabledCount})`;
}

function updateAllDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
        updateDecorations(editor);
    }
}

function formatCount(stat: LineStat | undefined): string {
    if (!stat || (stat.count === 0 && stat.time === 0)) {
        return '·'.padStart(maxCountWidth) + '  ';
    }
    return `${stat.count}`.padStart(maxCountWidth) + '× ';
}

function formatTimeStat(stat: LineStat | undefined): string {
    if (!stat || (stat.count === 0 && stat.time === 0)) {
        return '·'.padStart(maxTimeWidth) + ' ';
    }
    return formatTime(stat.time).padStart(maxTimeWidth) + ' ';
}

function getStatColor(stat: LineStat | undefined): vscode.ThemeColor {
    if (!stat || stat.time === 0) {
        return new vscode.ThemeColor('editorCodeLens.foreground');
    }
    if (stat.time > 100) {
        return new vscode.ThemeColor('errorForeground');
    }
    if (stat.time > 10) {
        return new vscode.ThemeColor('editorWarning.foreground');
    }
    return new vscode.ThemeColor('editorCodeLens.foreground');
}

function updateDecorations(editor: vscode.TextEditor) {
    const fileName = path.basename(editor.document.fileName).toLowerCase();
    const enabledFiles = statFiles.filter(f => f.enabled);

    // Clear all decorations first
    for (const dt of countDecorationTypes) {
        editor.setDecorations(dt, []);
    }
    for (const dt of timeDecorationTypes) {
        editor.setDecorations(dt, []);
    }

    if (perFileStats.length === 0) return;

    const totalLines = editor.document.lineCount;

    // Create decorations for each stat file (two columns per file)
    const enabledCount = perFileStats.length;
    for (let fileIndex = 0; fileIndex < enabledCount; fileIndex++) {
        const fileStatsMap = perFileStats[fileIndex];
        const lineStats = fileStatsMap.get(fileName);
        const statFileName = path.basename(enabledFiles[fileIndex]?.path || '');
        
        const countDecorations: vscode.DecorationOptions[] = [];
        const timeDecorations: vscode.DecorationOptions[] = [];

        for (let lineIndex = 0; lineIndex < totalLines; lineIndex++) {
            const line = lineIndex + 1;
            const stat = lineStats?.get(line);

            const hoverMessage = new vscode.MarkdownString();
            hoverMessage.appendMarkdown(`**${statFileName}**\n\n`);
            if (stat && (stat.count > 0 || stat.time > 0)) {
                hoverMessage.appendMarkdown(`- Calls: ${stat.count}\n`);
                hoverMessage.appendMarkdown(`- Time: ${stat.time}ms`);
            } else {
                hoverMessage.appendMarkdown(`_No data for this line_`);
            }

            countDecorations.push({
                range: new vscode.Range(lineIndex, 0, lineIndex, 0),
                renderOptions: {
                    before: {
                        contentText: formatCount(stat),
                        color: new vscode.ThemeColor('editorCodeLens.foreground')
                    }
                }
            });

            timeDecorations.push({
                range: new vscode.Range(lineIndex, 0, lineIndex, 0),
                hoverMessage: hoverMessage,
                renderOptions: {
                    before: {
                        contentText: formatTimeStat(stat),
                        color: getStatColor(stat)
                    }
                }
            });
        }

        if (countDecorationTypes[fileIndex]) {
            editor.setDecorations(countDecorationTypes[fileIndex], countDecorations);
        }
        if (timeDecorationTypes[fileIndex]) {
            editor.setDecorations(timeDecorationTypes[fileIndex], timeDecorations);
        }
    }
}

class StatFilesProvider implements vscode.TreeDataProvider<StatFileItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<StatFileItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: StatFileItem): vscode.TreeItem {
        return element;
    }

    getChildren(): StatFileItem[] {
        return statFiles.map(f => new StatFileItem(f));
    }
}

class StatFileItem extends vscode.TreeItem {
    constructor(public readonly statFile: StatFile) {
        super(path.basename(statFile.path), vscode.TreeItemCollapsibleState.None);
        
        this.tooltip = statFile.path;
        this.description = statFile.enabled ? '' : '(disabled)';
        this.iconPath = new vscode.ThemeIcon(statFile.enabled ? 'eye' : 'eye-closed');
        this.contextValue = 'statFile';
        this.command = {
            command: 'codestat.selectFile',
            title: 'Select File',
            arguments: [this]
        };
    }
}

class HotLinesProvider implements vscode.TreeDataProvider<HotLineItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HotLineItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    
    private selectedStatFile: string | null = null;
    private hotLines: HotLineInfo[] = [];

    refresh() {
        this.updateHotLines();
        this._onDidChangeTreeData.fire(undefined);
    }

    setSelectedFile(filePath: string | null) {
        this.selectedStatFile = filePath;
        this.refresh();
    }

    private updateHotLines() {
        this.hotLines = [];
        
        if (!this.selectedStatFile) {
            return;
        }

        const data = rawCodeStatData.get(this.selectedStatFile);
        if (!data) {
            return;
        }

        for (const [filePath, fileStats] of Object.entries(data)) {
            const fullPath = (fileStats as FileStats)['#path'] as string || filePath;
            const fileName = path.basename(filePath);

            for (const [funcName, funcData] of Object.entries(fileStats)) {
                if (funcName === '#path') continue;

                const funcStats = funcData as FunctionStats;
                for (const [lineStr, stat] of Object.entries(funcStats)) {
                    if (stat.time > 0) {
                        this.hotLines.push({
                            filePath: fullPath,
                            fileName,
                            line: parseInt(lineStr),
                            funcName,
                            count: stat.count,
                            time: stat.time
                        });
                    }
                }
            }
        }

        // Sort by time descending
        this.hotLines.sort((a, b) => b.time - a.time);
        
        // Keep top 50
        this.hotLines = this.hotLines.slice(0, 50);
    }

    getTreeItem(element: HotLineItem): vscode.TreeItem {
        return element;
    }

    getChildren(): HotLineItem[] {
        if (!this.selectedStatFile) {
            return [new HotLineItem({
                filePath: '',
                fileName: 'Select a stat file above',
                line: 0,
                funcName: '',
                count: 0,
                time: 0
            }, true)];
        }
        
        if (this.hotLines.length === 0) {
            return [new HotLineItem({
                filePath: '',
                fileName: 'No hot lines found',
                line: 0,
                funcName: '',
                count: 0,
                time: 0
            }, true)];
        }

        return this.hotLines.map(hl => new HotLineItem(hl, false));
    }
}

class HotLineItem extends vscode.TreeItem {
    constructor(public readonly hotLine: HotLineInfo, isPlaceholder: boolean) {
        super(
            isPlaceholder ? hotLine.fileName : `${hotLine.fileName}:${hotLine.line}`,
            vscode.TreeItemCollapsibleState.None
        );
        
        if (!isPlaceholder) {
            this.description = `${formatTime(hotLine.time)} (×${hotLine.count}) - ${hotLine.funcName}`;
            this.tooltip = `${hotLine.filePath}:${hotLine.line}\nFunction: ${hotLine.funcName}\nTime: ${hotLine.time}ms\nCalls: ${hotLine.count}`;
            this.iconPath = this.getIcon(hotLine.time);
            this.command = {
                command: 'codestat.goToLine',
                title: 'Go to Line',
                arguments: [hotLine]
            };
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }

    private getIcon(time: number): vscode.ThemeIcon {
        if (time > 100) {
            return new vscode.ThemeIcon('flame', new vscode.ThemeColor('errorForeground'));
        }
        if (time > 10) {
            return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
        }
        return new vscode.ThemeIcon('clock');
    }
}

interface CurrentFileLineInfo {
    line: number;
    funcName: string;
    count: number;
    time: number;
}

class CurrentFileHotLinesProvider implements vscode.TreeDataProvider<CurrentFileLineItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CurrentFileLineItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    
    private hotLines: CurrentFileLineInfo[] = [];

    refresh() {
        this.updateHotLines();
        this._onDidChangeTreeData.fire(undefined);
    }

    private updateHotLines() {
        this.hotLines = [];
        
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const fileName = path.basename(editor.document.fileName).toLowerCase();
        
        // Aggregate stats from all enabled stat files
        const lineStatsMap = new Map<number, { count: number; time: number; funcName: string }>();
        
        for (const [, data] of rawCodeStatData.entries()) {
            for (const [filePath, fileStats] of Object.entries(data)) {
                const dataFileName = path.basename(filePath).toLowerCase();
                if (dataFileName !== fileName) continue;

                for (const [funcName, funcData] of Object.entries(fileStats)) {
                    if (funcName === '#path') continue;

                    const funcStats = funcData as FunctionStats;
                    for (const [lineStr, stat] of Object.entries(funcStats)) {
                        const line = parseInt(lineStr);
                        if (stat.time > 0) {
                            const existing = lineStatsMap.get(line);
                            if (existing) {
                                existing.count += stat.count;
                                existing.time += stat.time;
                            } else {
                                lineStatsMap.set(line, { count: stat.count, time: stat.time, funcName });
                            }
                        }
                    }
                }
            }
        }

        // Convert to array
        for (const [line, stats] of lineStatsMap.entries()) {
            this.hotLines.push({
                line,
                funcName: stats.funcName,
                count: stats.count,
                time: stats.time
            });
        }

        // Sort by time descending
        this.hotLines.sort((a, b) => b.time - a.time);
        
        // Keep top 30
        this.hotLines = this.hotLines.slice(0, 30);
    }

    getTreeItem(element: CurrentFileLineItem): vscode.TreeItem {
        return element;
    }

    getChildren(): CurrentFileLineItem[] {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return [new CurrentFileLineItem(null, 'No file open')];
        }
        
        if (this.hotLines.length === 0) {
            return [new CurrentFileLineItem(null, 'No hot lines')];
        }

        return this.hotLines.map(hl => new CurrentFileLineItem(hl, ''));
    }
}

class CurrentFileLineItem extends vscode.TreeItem {
    constructor(public readonly lineInfo: CurrentFileLineInfo | null, placeholder: string) {
        super(
            lineInfo ? `Line ${lineInfo.line}` : placeholder,
            vscode.TreeItemCollapsibleState.None
        );
        
        if (lineInfo) {
            this.description = `${formatTime(lineInfo.time)} (×${lineInfo.count}) - ${lineInfo.funcName}`;
            this.tooltip = `Line: ${lineInfo.line}\nFunction: ${lineInfo.funcName}\nTime: ${lineInfo.time}ms\nCalls: ${lineInfo.count}`;
            this.iconPath = this.getIcon(lineInfo.time);
            this.command = {
                command: 'codestat.goToLineInCurrentFile',
                title: 'Go to Line',
                arguments: [lineInfo.line]
            };
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }

    private getIcon(time: number): vscode.ThemeIcon {
        if (time > 100) {
            return new vscode.ThemeIcon('flame', new vscode.ThemeColor('errorForeground'));
        }
        if (time > 10) {
            return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
        }
        return new vscode.ThemeIcon('clock');
    }
}

export function deactivate() {}

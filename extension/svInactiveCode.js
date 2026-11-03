'use strict';

const path = require('path');
const crypto = require('crypto');
const keyFor = file => {
  const key = path.resolve(file).replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
};

// Only consumes immutable Slang source ranges. Does not evaluate macros, edit
// diagnostics or request any graph / hierarchy / layout work.
class InactiveCodeDecorations {
  constructor(vscode, positionAtByte) {
    this.vscode = vscode;
    this.positionAtByte = positionAtByte;
    this.enabled = true;
    this.epoch = 0;
    this.documents = new Map();
    this.type = vscode.window?.createTextEditorDecorationType?.({
      opacity: '0.45', rangeBehavior: vscode.DecorationRangeBehavior?.ClosedClosed,
    });
    this.listener = vscode.window?.onDidChangeVisibleTextEditors?.(() => this.render());
  }

  clear(enabled = this.enabled) {
    const hadDecorations = this.documents.size > 0;
    this.enabled = enabled;
    this.epoch++;
    this.documents.clear();
    if (hadDecorations) this.render();
  }

  forget(document) {
    this.epoch++;
    this.documents.delete(keyFor(document.uri.fsPath));
    this.render();
  }

  capture(documents) {
    return documents.filter(d => d?.uri).map(document => ({ document, version: document.version }));
  }

  publish(result, snapshots, epoch, priority = 1) {
    if (!this.enabled || epoch !== this.epoch || !result?.preprocessor) return;
    const { preprocessedFiles = [], inactiveRegions = [] } = result.preprocessor;
    const files = new Set(preprocessedFiles.map(keyFor));
    const digests = new Map(Object.entries(result.inputDigests || {}).map(([file, digest]) => [keyFor(file), digest]));
    const byFile = new Map();
    for (const region of inactiveRegions) {
      if (!region.file || !Number.isInteger(region.offset) || region.offset < 0 ||
          !Number.isInteger(region.length) || region.length <= 0) continue;
      const key = keyFor(region.file);
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(region);
    }
    for (const { document, version } of snapshots) {
      if (document.isClosed || document.version !== version) continue;
      const key = keyFor(document.uri.fsPath);
      if (!files.has(key)) continue;
      const previous = this.documents.get(key);
      if (previous && previous.priority > priority) continue;
      const text = document.getText();
      const digest = digests.get(key);
      if (!digest || crypto.createHash('sha256').update(text, 'utf8').digest('hex') !== digest) {
        this.documents.delete(key);
        continue;
      }
      const ranges = (byFile.get(key) || []).map(region => {
        const start = this.positionAtByte(text, region.offset);
        const end = this.positionAtByte(text, region.offset + region.length);
        return new this.vscode.Range(start.line, start.character, end.line, end.character);
      });
      this.documents.set(key, { document, version, ranges, priority });
    }
    this.render();
  }

  render() {
    if (!this.type) return;
    for (const editor of this.vscode.window?.visibleTextEditors || []) {
      const record = this.documents.get(keyFor(editor.document.uri.fsPath));
      const current = this.enabled && record && record.document === editor.document &&
        record.version === editor.document.version;
      editor.setDecorations(this.type, current ? record.ranges : []);
    }
  }

  dispose() {
    this.clear(false);
    this.listener?.dispose();
    this.type?.dispose();
  }
}

module.exports = { InactiveCodeDecorations };

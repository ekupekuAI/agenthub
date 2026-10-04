/**
 * Comment strippers. Each returns the input with comments replaced by spaces, keeping line
 * breaks and column positions, so findings point at the original lines. String literals are
 * kept because subjects (commands, hosts, paths) are read from them.
 */

export function stripJsComments(text: string): string {
  let out = '';
  let state: 'code' | 'sq' | 'dq' | 'tpl' | 'line' | 'block' = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1] ?? '';
    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line';
          out += '  ';
          i++;
        } else if (c === '/' && next === '*') {
          state = 'block';
          out += '  ';
          i++;
        } else if (c === '\\') {
          out += c + next;
          i++;
        } else {
          if (c === "'") state = 'sq';
          else if (c === '"') state = 'dq';
          else if (c === '`') state = 'tpl';
          out += c;
        }
        break;
      case 'sq':
      case 'dq':
        if (c === '\\') {
          out += c + next;
          i++;
          break;
        }
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || c === '\n') {
          state = 'code';
        }
        out += c;
        break;
      case 'tpl':
        if (c === '\\') {
          out += c + next;
          i++;
          break;
        }
        if (c === '`') state = 'code';
        out += c;
        break;
      case 'line':
        if (c === '\n') {
          state = 'code';
          out += '\n';
        } else {
          out += ' ';
        }
        break;
      case 'block':
        if (c === '*' && next === '/') {
          state = 'code';
          out += '  ';
          i++;
        } else {
          out += c === '\n' ? '\n' : ' ';
        }
        break;
    }
  }
  return out;
}

/** Strips `#` comments and statement-level triple-quoted strings (docstrings). */
export function stripPythonComments(text: string): string {
  let out = '';
  let state: 'code' | 'sq' | 'dq' | 'triple' | 'doc' | 'comment' = 'code';
  let quote = '';
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1] ?? '';
    if (c === '\n') lineStart = i + 1;
    switch (state) {
      case 'code': {
        if (c === '#') {
          state = 'comment';
          out += ' ';
          break;
        }
        const three = text.slice(i, i + 3);
        if (three === '"""' || three === "'''") {
          const before = text.slice(lineStart, i);
          quote = three;
          if (/^\s*[rRbBuUfF]{0,2}$/.test(before)) {
            state = 'doc';
            out += '   ';
          } else {
            state = 'triple';
            out += three;
          }
          i += 2;
          break;
        }
        if (c === "'" || c === '"') {
          state = c === "'" ? 'sq' : 'dq';
          quote = c;
        }
        out += c;
        break;
      }
      case 'sq':
      case 'dq':
        if (c === '\\') {
          out += c + next;
          i++;
          break;
        }
        if (c === quote || c === '\n') state = 'code';
        out += c;
        break;
      case 'triple':
      case 'doc':
        if (c === '\\') {
          if (state === 'doc') out += next === '\n' ? ' \n' : '  ';
          else out += c + next;
          if (next === '\n') lineStart = i + 2;
          i++;
          break;
        }
        if (text.startsWith(quote, i)) {
          out += state === 'doc' ? '   ' : quote;
          state = 'code';
          i += 2;
          break;
        }
        out += state === 'doc' && c !== '\n' ? ' ' : c;
        break;
      case 'comment':
        if (c === '\n') {
          state = 'code';
          out += '\n';
        } else {
          out += ' ';
        }
        break;
    }
  }
  return out;
}

/** Strips `#` comments from POSIX shell lines. Quote state resets at every line end. */
export function stripShellComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let quote = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i] as string;
        if (quote === "'") {
          if (c === "'") quote = '';
        } else if (c === '\\') {
          i++;
        } else if (quote === '"') {
          if (c === '"') quote = '';
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === '#' && (i === 0 || /[\s;|&(]/.test(line[i - 1] as string))) {
          return line.slice(0, i) + ' '.repeat(line.length - i);
        }
      }
      return line;
    })
    .join('\n');
}

/** Strips `#` and `<# … #>` comments from PowerShell. */
export function stripPowerShellComments(text: string): string {
  let out = '';
  let block = false;
  for (const line of text.split('\n')) {
    let result = '';
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string;
      if (block) {
        if (c === '#' && line[i + 1] === '>') {
          block = false;
          result += '  ';
          i++;
        } else {
          result += ' ';
        }
        continue;
      }
      if (quote !== '') {
        if (c === '`' && quote === '"') {
          result += c + (line[i + 1] ?? '');
          i++;
          continue;
        }
        if (c === quote) quote = '';
        result += c;
        continue;
      }
      if (c === '<' && line[i + 1] === '#') {
        block = true;
        result += '  ';
        i++;
        continue;
      }
      if (c === '#' && (i === 0 || /[\s;|&(){}]/.test(line[i - 1] as string))) {
        result += ' '.repeat(line.length - i);
        break;
      }
      if (c === "'" || c === '"') quote = c;
      result += c;
    }
    out += `${result}\n`;
  }
  return out.slice(0, -1);
}

/** Blanks `REM` and `::` comment lines in batch files. */
export function stripBatchComments(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^\s*@?\s*(?:rem(?:\s|$)|::)/i.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');
}

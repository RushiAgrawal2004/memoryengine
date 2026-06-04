import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface SymbolAnchorData {
  startLine: number;
  endLine: number;
  symbolHash: string;
}

interface SymbolMatch {
  startOffset: number;
  endOffset: number;
}

export async function hashSymbolInFile(
  filePath: string,
  symbol: string,
  cwd = process.cwd(),
): Promise<SymbolAnchorData | undefined> {
  const content = await readFile(path.resolve(cwd, filePath), "utf8").catch(() => undefined);
  if (content === undefined) {
    return undefined;
  }

  return hashSymbolText(content, symbol);
}

export function hashSymbolText(
  content: string,
  symbol: string,
): SymbolAnchorData | undefined {
  const match = findSymbolMatch(content, symbol);
  if (!match) {
    return undefined;
  }

  const text = content.slice(match.startOffset, match.endOffset);
  return {
    startLine: lineNumberAt(content, match.startOffset),
    endLine: lineNumberAt(content, Math.max(match.endOffset - 1, match.startOffset)),
    symbolHash: hashText(text),
  };
}

export function hashText(content: string): string {
  return createHash("sha256").update(normalizeLineEndings(content)).digest("hex");
}

function findSymbolMatch(content: string, symbol: string): SymbolMatch | undefined {
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`(^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b[^\\n]*`, "m"),
    new RegExp(`(^|\\n)\\s*(?:export\\s+)?class\\s+${escaped}\\b[^\\n]*`, "m"),
    new RegExp(`(^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b[^\\n]*`, "m"),
    new RegExp(`(^|\\n)\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?${escaped}\\s*\\([^\\n]*`, "m"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (!match || match.index === undefined) {
      continue;
    }

    const startOffset = match.index + (match[1] === "\n" ? 1 : 0);
    return {
      startOffset,
      endOffset: findDeclarationEnd(content, startOffset),
    };
  }

  return undefined;
}

function findDeclarationEnd(content: string, startOffset: number): number {
  const firstLineEnd = content.indexOf("\n", startOffset);
  const fallbackEnd = firstLineEnd === -1 ? content.length : firstLineEnd;
  const braceStart = content.indexOf("{", startOffset);
  if (braceStart === -1 || braceStart > fallbackEnd + 200) {
    return fallbackEnd;
  }

  let depth = 0;
  for (let index = braceStart; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return includeTrailingLineEnd(content, index + 1);
      }
    }
  }

  return fallbackEnd;
}

function includeTrailingLineEnd(content: string, offset: number): number {
  if (content[offset] === "\r" && content[offset + 1] === "\n") {
    return offset + 2;
  }
  if (content[offset] === "\n") {
    return offset + 1;
  }
  return offset;
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === "\n") {
      line += 1;
    }
  }

  return line;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

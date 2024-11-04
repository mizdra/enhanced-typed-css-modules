import { EOL } from 'os';
import path, { basename, parse, join } from 'path';
import camelcase from 'camelcase';
import { SourceNode, type CodeWithSourceMap } from '../library/source-map/index.js';
import { type Token } from '../locator/index.js';
import { type LocalsConvention } from '../runner.js';
import { getRelativePath, type DtsFormatOptions } from './index.js';

const CURRENT_WORKING_DIRECTORY = process.cwd();

/**
 * Get .d.ts file path.
 * @param filePath The path to the source file (i.e. `/dir/foo.css`). It is absolute.
 * @param arbitraryExtensions Generate `.d.css.ts` instead of `.css.d.ts`.
 * @param outDir Output directory for generated files.
 * @returns The path to the .d.ts file. It is absolute.
 */
export function getDtsFilePath(filePath: string, arbitraryExtensions: boolean, outDir: string | undefined): string {
  let outputFilePath = filePath;
  if (outDir) {
    const relativePath = path.relative(CURRENT_WORKING_DIRECTORY, filePath);
    outputFilePath = path.resolve(CURRENT_WORKING_DIRECTORY, outDir, relativePath);
  }

  if (arbitraryExtensions) {
    const { dir, name, ext } = parse(outputFilePath);
    return join(dir, `${name}.d${ext}.ts`);
  } else {
    return `${outputFilePath}.d.ts`;
  }
}

function dashesCamelCase(str: string): string {
  return str.replace(/-+(\w)/gu, (match, firstLetter) => {
    return firstLetter.toUpperCase();
  });
}

function formatTokens(tokens: Token[], localsConvention: LocalsConvention): Token[] {
  function formatToken(token: Token, formatter: (str: string) => string): Token {
    if ('importedName' in token && typeof token.importedName === 'string') {
      return { ...token, name: formatter(token.name), importedName: formatter(token.importedName) };
    } else {
      return { ...token, name: formatter(token.name) };
    }
  }

  const result: Token[] = [];
  for (const token of tokens) {
    if (localsConvention === 'camelCaseOnly') {
      result.push(formatToken(token, camelcase));
    } else if (localsConvention === 'camelCase') {
      result.push(token);
      result.push(formatToken(token, camelcase));
    } else if (localsConvention === 'dashesOnly') {
      result.push(formatToken(token, dashesCamelCase));
    } else if (localsConvention === 'dashes') {
      result.push(token);
      result.push(formatToken(token, dashesCamelCase));
    } else {
      result.push(token); // asIs
    }
  }
  return result;
}

function generateTokenDeclarations(
  filePath: string,
  sourceMapFilePath: string,
  tokens: Token[],
  dtsFormatOptions: DtsFormatOptions | undefined,
  isExternalFile: (filePath: string) => boolean,
): (typeof SourceNode)[] {
  const formattedTokens = formatTokens(tokens, dtsFormatOptions?.localsConvention);
  const result: (typeof SourceNode)[] = [];

  for (const token of formattedTokens) {
    // Only one original position can be associated with one generated position.
    // This is due to the sourcemap specification. Therefore, we output multiple type definitions
    // with the same name and assign a separate original position to each.

    let originalLocation = token.originalLocation;
    if (originalLocation.filePath === undefined) {
      // If the original location is not specified, fallback to the source file.
      originalLocation = {
        filePath,
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      };
    }

    result.push(
      originalLocation.filePath === filePath || isExternalFile(originalLocation.filePath)
        ? new SourceNode(null, null, null, [
            '& Readonly<{ ',
            new SourceNode(
              originalLocation.start.line ?? null,
              // The SourceNode's column is 0-based, but the originalLocation's column is 1-based.
              originalLocation.start.column - 1 ?? null,
              getRelativePath(sourceMapFilePath, originalLocation.filePath),
              `"${token.name}"`,
              token.name,
            ),
            ': string }>',
          ])
        : typeof token.importedName === 'string'
        ? new SourceNode(null, null, null, [
            `& Readonly<{ `,
            new SourceNode(
              originalLocation.start.line ?? null,
              // The SourceNode's column is 0-based, but the originalLocation's column is 1-based.
              originalLocation.start.column - 1 ?? null,
              getRelativePath(sourceMapFilePath, originalLocation.filePath),
              `"${token.name}"`,
              token.name,
            ),
            `: (typeof import(`,
            `"${getRelativePath(filePath, originalLocation.filePath)}"`,
            `))["default"]["${token.importedName}"] }>`,
          ])
        : // Imported tokens in non-external files are typed by dynamic import.
          // See https://github.com/mizdra/happy-css-modules/issues/106.
          new SourceNode(null, null, null, [
            '& Readonly<Pick<(typeof import(',
            `"${getRelativePath(filePath, originalLocation.filePath)}"`,
            '))["default"], ',
            `"${token.name}"`,
            '>>',
          ]),
    );
  }
  return result;
}

// eslint-disable-next-line max-params
export function generateDtsContentWithSourceMap(
  filePath: string,
  dtsFilePath: string,
  sourceMapFilePath: string,
  tokens: Token[],
  dtsFormatOptions: DtsFormatOptions | undefined,
  isExternalFile: (filePath: string) => boolean,
): { dtsContent: CodeWithSourceMap['code']; sourceMap: CodeWithSourceMap['map'] } {
  const tokenDeclarations = generateTokenDeclarations(
    filePath,
    sourceMapFilePath,
    tokens,
    dtsFormatOptions,
    isExternalFile,
  );

  let sourceNode: typeof SourceNode;
  if (!tokenDeclarations || !tokenDeclarations.length) {
    sourceNode = new SourceNode(null, null, null, '');
  } else {
    sourceNode = new SourceNode(1, 0, getRelativePath(sourceMapFilePath, filePath), [
      `declare const styles:${EOL}`,
      ...tokenDeclarations.map((tokenDeclaration) => ['  ', tokenDeclaration, EOL]),
      `;${EOL}`,
      `export default styles;${EOL}`,
    ]);
  }
  const codeWithSourceMap = sourceNode.toStringWithSourceMap({
    // Since sourcemap and type definitions are in the same directory, they can be referenced by relative paths.
    file: basename(dtsFilePath),
    sourceRoot: '',
  });
  return {
    dtsContent: codeWithSourceMap.code,
    sourceMap: codeWithSourceMap.map,
  };
}

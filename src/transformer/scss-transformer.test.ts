/* eslint-disable @typescript-eslint/require-array-sort-compare */
import { pathToFileURL } from 'url';
import { jest } from '@jest/globals';
import dedent from 'dedent';
import { rest } from 'msw';
import { Loader } from '../loader/index.js';
import { server } from '../test/msw.js';
import { createFixtures, getFixturePath } from '../test/util.js';
import { createScssTransformer } from './scss-transformer.js';

const loader = new Loader({ transformer: createScssTransformer() });
const loadSpy = jest.spyOn(loader, 'load');

afterEach(() => {
  loadSpy.mockClear();
});

test('handles sass features', async () => {
  createFixtures({
    '/test/1.scss': dedent`
      @use './2.scss' as two; // sass feature test (@use)
      @import './3.scss'; // css feature test (@import)
      .a_1 { dummy: ''; }
      .a_2 {
        dummy: '';
        // sass feature test (nesting)
        .a_2_1 { dummy: ''; }
        &_2 { dummy: ''; }
        composes: a_1; // css module feature test (composes)
        composes: d from './4.scss'; // css module feature test (composes from other file)
      }
      `,
    '/test/2.scss': dedent`
      .b_1 { dummy: ''; }
      @mixin b_2 { dummy: ''; }
      `,
    '/test/3.scss': dedent`
      .c { dummy: ''; }
      `,
    '/test/4.scss': dedent`
      .d { dummy: ''; }
      `,
  });
  const result = await loader.load(pathToFileURL(getFixturePath('/test/1.scss')).href);

  // NOTE: There should be only one originalLocations for 'a_2', but there are multiple.
  // This is probably due to an incorrect sourcemap output by the sass compiler.
  // FIXME: The sass compiler or Loader implementation needs to be fixed.

  // FIXME: The end position of 'a_2_2' is incorrect.
  expect(result).toMatchInlineSnapshot(`
    {
      dependencies: ["file://<fixtures>/test/2.scss", "file://<fixtures>/test/3.scss", "file://<fixtures>/test/4.scss"],
      tokens: [
        {
          name: "b_1",
          originalLocations: [
            { fileURL: "file://<fixtures>/test/2.scss", start: { line: 1, column: 1 }, end: { line: 1, column: 3 } },
          ],
        },
        {
          name: "c",
          originalLocations: [
            { fileURL: "file://<fixtures>/test/3.scss", start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
          ],
        },
        {
          name: "a_1",
          originalLocations: [
            { fileURL: "file://<fixtures>/test/1.scss", start: { line: 3, column: 1 }, end: { line: 3, column: 3 } },
          ],
        },
        {
          name: "a_2",
          originalLocations: [
            { fileURL: "file://<fixtures>/test/1.scss", start: { line: 4, column: 1 }, end: { line: 4, column: 3 } },
            { fileURL: "file://<fixtures>/test/1.scss", start: { line: 7, column: 3 }, end: { line: 7, column: 5 } },
          ],
        },
        {
          name: "a_2_1",
          originalLocations: [
            { fileURL: "file://<fixtures>/test/1.scss", start: { line: 7, column: 3 }, end: { line: 7, column: 7 } },
          ],
        },
        {
          name: "a_2_2",
          originalLocations: [
            { fileURL: "file://<fixtures>/test/1.scss", start: { line: 8, column: 3 }, end: { line: 8, column: 7 } },
          ],
        },
        {
          name: "d",
          originalLocations: [
            { fileURL: "file://<fixtures>/test/4.scss", start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
          ],
        },
      ],
    }
  `);
});

test('tracks dependencies that have been pre-bundled by sass compiler', async () => {
  createFixtures({
    '/test/1.scss': dedent`
    @import './2.scss';
    @import './3.scss';
    `,
    '/test/2.scss': dedent`
    `,
    '/test/3.scss': dedent`
    @import './4.scss';
    `,
    '/test/4.scss': dedent`
    `,
  });
  const result = await loader.load(pathToFileURL(getFixturePath('/test/1.scss')).href);

  // The files imported using @import are pre-bundled by the compiler.
  // Therefore, `Loader#load` is not called to process other files.
  expect(loadSpy).toBeCalledTimes(1);
  expect(loadSpy).toHaveBeenNthCalledWith(1, pathToFileURL(getFixturePath('/test/1.scss')).href);

  // The files pre-bundled by the compiler are also included in `result.dependencies`
  expect(result.dependencies).toStrictEqual(
    ['/test/2.scss', '/test/3.scss', '/test/4.scss'].map((path) => pathToFileURL(getFixturePath(path)).href),
  );
});

test('resolves specifier using resolver', async () => {
  createFixtures({
    '/test/1.scss': dedent`
    @import 'package-1';
    @import 'package-2';
    @import './recursive.scss';
    @import 'http://example.com/path/http.scss';
    @import 'https://example.com/path/https.scss';
    @import 'https://example.com/path/recursive.scss';
    `,
    '/node_modules/package-1/index.css': `.a {}`,
    '/node_modules/package-2/index.scss': `.a {}`,
    '/test/recursive.scss': `@import './recursive-imported.scss';`,
    '/test/recursive-imported.scss': `.a {}`,
  });
  server.use(rest.all(`http://example.com/path/http.scss`, (_req, res, ctx) => res(ctx.text('.a {}'))));
  server.use(rest.all(`https://example.com/path/https.scss`, (_req, res, ctx) => res(ctx.text('.a {}'))));
  server.use(
    rest.all(`https://example.com/path/recursive.scss`, (_req, res, ctx) =>
      res(ctx.text('@import "./recursive-imported.scss";')),
    ),
  );
  server.use(rest.all(`https://example.com/path/recursive-imported.scss`, (_req, res, ctx) => res(ctx.text('.a {}'))));
  const result = await loader.load(pathToFileURL(getFixturePath('/test/1.scss')).href);
  expect(result.dependencies.sort()).toStrictEqual(
    [
      pathToFileURL(getFixturePath('/node_modules/package-1/index.css')).href,
      pathToFileURL(getFixturePath('/node_modules/package-2/index.scss')).href,
      pathToFileURL(getFixturePath('/test/recursive.scss')).href,
      pathToFileURL(getFixturePath('/test/recursive-imported.scss')).href,
      'http://example.com/path/http.scss',
      'https://example.com/path/https.scss',
      'https://example.com/path/recursive.scss',
      // FIXME: Since dart-scss cannot compile http/https files, happy-css-modules treats such files as empty sass files.
      // Therefore, files imported from http/https files are not included in `result.dependencies`.
      // 'https://example.com/path/recursive-imported.scss',
    ].sort(),
  );
});

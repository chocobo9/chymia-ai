// M10 file-tools — read_file + search_files.
//
// Source: clowder-architecture-design.md §5.7 + the FROZEN M8 contract
// (.harness/progress.md):
//   read_file {path}           → POST /api/callback/read_file → 200 {path,content}; escape → 403; missing → 404; oversize → 413
//   search_files {query,path?} → POST /api/callback/search_files → 200 {query,matches}; escape → 403
//
// The sandbox + traversal guard live server-side (callback-routes resolves
// paths against fileRoot). We forward the path verbatim and let the API enforce
// the boundary — a 403 surfaces to the agent as an isError ToolResult.

import { z } from 'zod';
import type { CallbackClient } from '../callback-client.js';
import { toToolResult } from '../tool-result.js';
import type { ToolDef } from './tool-def.js';

const readFileInputSchema = {
  path: z
    .string()
    .min(1)
    .describe('Project-relative path of the file to read (sandboxed to the project root by the server).'),
} as const;

const searchFilesInputSchema = {
  query: z.string().min(1).describe('Literal substring to search for across project files (case-insensitive).'),
  path: z
    .string()
    .min(1)
    .optional()
    .describe('Optional sub-directory (project-relative) to scope the search to; still sandboxed.'),
} as const;

/** Build the file tool group from the shared callback client. */
export function buildFileTools(client: CallbackClient): ToolDef[] {
  return [
    {
      name: 'read_file',
      description: 'Read the contents of a project file (sandboxed to the project root).',
      inputSchema: readFileInputSchema,
      handler: async (args) => {
        const input = z.object(readFileInputSchema).parse(args);
        return toToolResult(await client.post('read_file', { path: input.path }));
      },
    },
    {
      name: 'search_files',
      description: 'Content-search project files for a substring (sandboxed; returns matching files + line snippets).',
      inputSchema: searchFilesInputSchema,
      handler: async (args) => {
        const input = z.object(searchFilesInputSchema).parse(args);
        const body: Record<string, unknown> = { query: input.query };
        if (input.path !== undefined) {
          body.path = input.path;
        }
        return toToolResult(await client.post('search_files', body));
      },
    },
  ];
}

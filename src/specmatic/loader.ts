/**
 * Specmatic stub loader — reads externalised stub data from <contract>_data/ directories.
 *
 * Specmatic's externalised stub format per file:
 * {
 *   "http-request": { "method": "...", "path": "...", ... },
 *   "http-response": { "status": 200, ... }
 * }
 *
 * Field names are normalised: http-request → request, http-response → response.
 */

import fs from 'fs';
import path from 'path';
import type { JsonValue } from '../types.js';
import type { ExpectationRequest, ExpectationResponse } from './types.js';

interface StubFileEntry {
  readonly request: ExpectationRequest;
  readonly response: ExpectationResponse;
  readonly filePath: string;
}

/**
 * Recursively walk `dir` and read every *.json file as a Specmatic stub pair.
 * Files that cannot be parsed or lack the expected shape are silently skipped.
 *
 * @param dir - Absolute path to the directory to scan.
 * @returns Array of normalised { request, response, filePath } objects.
 */
export async function loadExpectationsFromDirectory(dir: string): Promise<StubFileEntry[]> {
  const results: StubFileEntry[] = [];
  await walkDir(dir, results);
  return results;
}

async function walkDir(dir: string, results: StubFileEntry[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory does not exist or is not accessible — skip silently
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const stub = await readStubFile(fullPath);
      if (stub !== null) {
        results.push(stub);
      }
    }
  }
}

async function readStubFile(filePath: string): Promise<StubFileEntry | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const rawRequest = record['http-request'];
    const rawResponse = record['http-response'];

    if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) return null;
    if (!rawResponse || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) return null;

    const reqObj = rawRequest as Record<string, unknown>;
    const resObj = rawResponse as Record<string, unknown>;

    // Validate required fields
    if (typeof reqObj['method'] !== 'string') return null;
    if (typeof reqObj['path'] !== 'string') return null;
    if (typeof resObj['status'] !== 'number') return null;

    const request: ExpectationRequest = {
      method: reqObj['method'] as string,
      path: reqObj['path'] as string,
      headers: isStringRecord(reqObj['headers']) ? reqObj['headers'] as Record<string, string> : undefined,
      queryParameters: isStringOrArrayRecord(reqObj['query']) ? reqObj['query'] as Record<string, string | string[]> : undefined,
      body: reqObj['body'] !== undefined ? reqObj['body'] as JsonValue : undefined,
    };

    const response: ExpectationResponse = {
      status: resObj['status'] as number,
      headers: isStringRecord(resObj['headers']) ? resObj['headers'] as Record<string, string> : undefined,
      body: resObj['body'] !== undefined ? resObj['body'] as JsonValue : undefined,
    };

    return { request, response, filePath };
  } catch {
    // JSON parse error or I/O failure — skip file silently
    return null;
  }
}

function isStringRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

function isStringOrArrayRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => typeof x === 'string' || (Array.isArray(x) && x.every((e) => typeof e === 'string')),
  );
}

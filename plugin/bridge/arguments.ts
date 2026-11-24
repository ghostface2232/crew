/**
 * Checks a tool call's arguments against the tool's declared schema. Hosts pass along arguments a tool does not declare,
 * and a handler reading only the ones it knows would drop the rest without a word, so a misnamed brief started a job
 * with no brief. Only names are checked; values stay the handlers' to judge.
 */
/** Loose on purpose: tool lists are object literals whose inferred types differ per tool. */
type Schema = { properties?: object; items?: unknown };
export type Tool = { name: string; inputSchema: Schema };
/** An argument the schema does not declare, and the names declared where it was found. */
export type Undeclared = { path: string; parent: string; allowed: string[] };

/**
 * Fields a host adds to every call by itself, which no tool declares: agy 1.5 adds `toolSummary` to each Antigravity
 * worker's call (seen in its transcripts, 2026-11-25). Refusing them would refuse every call that host makes.
 */
const HOST_FIELDS = new Set(['toolSummary']);

/** Each argument the schema does not declare, by path (e.g. `tasks[0].owner`), nested ones included. */
export function undeclared(schema: Schema, value: unknown, at = ''): Undeclared[] {
  if (Array.isArray(value)) return schema.items ? value.flatMap((item, i) => undeclared(schema.items as Schema, item, `${at}[${i}]`)) : [];
  if (!schema.properties || value === null || typeof value !== 'object') return [];
  const properties = schema.properties as Record<string, Schema>;
  return Object.entries(value).flatMap(([key, inner]) => {
    // Own keys only, so `toString` or `__proto__` is not taken for a declared argument.
    if (Object.hasOwn(properties, key)) return undeclared(properties[key], inner, at ? `${at}.${key}` : key);
    if (!at && HOST_FIELDS.has(key)) return [];
    return [{ path: at ? `${at}.${key}` : key, parent: at, allowed: Object.keys(properties) }];
  });
}

/**
 * Fails a call that passes an argument its tool does not declare, before it does anything, naming the arguments taken
 * where each unknown one was found. `hint` adds a line for a name that is likely a mix-up. An unknown tool is left to the
 * handler.
 */
export function checkArguments(tools: Tool[], name: string, args: unknown, hint: (tool: string, key: string) => string | undefined = () => undefined): void {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return;
  const unknown = undeclared(tool.inputSchema, args);
  if (!unknown.length) return;
  const hints = [...new Set(unknown.map(({ path }) => hint(name, path)).filter(Boolean))];
  const levels = [...new Map(unknown.map((item) => [item.parent, item])).values()].map(({ parent, allowed }) => {
    if (parent) return `\`${parent}\` takes ${allowed.length ? allowed.join(', ') : 'no fields'}.`;
    return allowed.length ? `Its arguments: ${allowed.join(', ')}.` : 'It takes no arguments.';
  });
  throw new Error([`${name} does not take ${unknown.map(({ path }) => `\`${path}\``).join(', ')}, so nothing was done.`, ...hints, ...levels].join(' '));
}

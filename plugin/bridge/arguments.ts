/**
 * Checks a tool call's arguments against the tool's declared schema. Hosts pass along arguments a tool does not declare,
 * and a handler reading only the ones it knows would drop the rest without a word, so a misnamed brief started a job
 * with no brief. Only names are checked; values stay the handlers' to judge.
 */
/** Loose on purpose: tool lists are object literals whose inferred types differ per tool. */
type Schema = { properties?: object; items?: unknown };
export type Tool = { name: string; inputSchema: Schema };

/** Each argument name the schema does not declare, with its path, e.g. `tasks[0].owner`. */
export function undeclared(schema: Schema, value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return schema.items ? value.flatMap((item, i) => undeclared(schema.items as Schema, item, `${at}[${i}]`)) : [];
  if (!schema.properties || value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    const path = at ? `${at}.${key}` : key;
    // Own keys only, so `toString` or `__proto__` is not taken for a declared argument.
    const declared = Object.hasOwn(schema.properties!, key) ? (schema.properties as Record<string, Schema>)[key] : undefined;
    return declared ? undeclared(declared, inner, path) : [path];
  });
}

/**
 * Fails a call that passes an argument its tool does not declare, before it does anything, naming the arguments the tool
 * takes. `hint` adds a line for a name that is likely a mix-up. An unknown tool is left to the handler.
 */
export function checkArguments(tools: Tool[], name: string, args: unknown, hint: (tool: string, key: string) => string | undefined = () => undefined): void {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return;
  const unknown = undeclared(tool.inputSchema, args);
  if (!unknown.length) return;
  const hints = [...new Set(unknown.map((key) => hint(name, key)).filter(Boolean))];
  throw new Error([
    `${name} does not take ${unknown.map((key) => `\`${key}\``).join(', ')}, so nothing was done.`,
    ...hints,
    `Its arguments: ${Object.keys(tool.inputSchema.properties ?? {}).join(', ')}. Call it again with these names.`,
  ].join(' '));
}

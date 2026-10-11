export const snapshotOptions = {
  scopeUid: { type: 'string', minLength: 1, description: 'Return this current UID and its descendants. Omit for full page. Inline only.' },
  match: {
    type: 'object', minProperties: 1, additionalProperties: false,
    properties: { role: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 } },
    description: 'Exact accessible role and/or name. Returns matching subtrees and structuredContent.matches UIDs; no initial full snapshot needed. Inline only.',
  },
};

export const snapshotOutput = {
  type: 'object', properties: {
    matches: { type: 'array', items: {
      type: 'object', properties: { uid: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } },
      required: ['uid'], additionalProperties: false,
    } },
  }, additionalProperties: true,
};

export function snapshotArguments(params) {
  const { scopeUid, match, ...upstream } = params;
  if (scopeUid !== undefined && (typeof scopeUid !== 'string' || !scopeUid.trim())) throw new Error('scopeUid must be a non-empty snapshot UID.');
  if (match !== undefined && (!match || typeof match !== 'object' || Array.isArray(match) || !Object.keys(match).length ||
    Object.entries(match).some(([key, value]) => !['role', 'name'].includes(key) || typeof value !== 'string' || !value.trim()))) {
    throw new Error('match requires an exact role and/or name, each a non-empty string.');
  }
  if (params.filePath !== undefined && (scopeUid !== undefined || match !== undefined)) {
    throw new Error('scopeUid and match are inline options; omit filePath or these options.');
  }
  return upstream;
}

function findNode(node, uid) {
  if (node.id === uid) return node;
  for (const child of node.children ?? []) {
    const match = findNode(child, uid);
    if (match) return match;
  }
}

function findMatches(node, match) {
  const roots = [], matches = [];
  const visit = (node, covered = false) => {
    const found = Object.entries(match).every(([key, value]) => node[key] === value);
    if (found) { matches.push(node); if (!covered) roots.push(node); }
    for (const child of node.children ?? []) visit(child, covered || found);
  };
  visit(node);
  return { roots, matches };
}

function snapshotText(node, depth = 0) {
  const { id, role, children = [], ...attributes } = node;
  // Preserve every upstream attribute and actionable UID; quote multiline data.
  const fields = [`uid=${id}`, role, ...Object.entries(attributes).map(([key, value]) => `${key}=${JSON.stringify(value)}`)].filter(Boolean);
  return `${'  '.repeat(depth)}${fields.join(' ')}\n` + children.map(child => snapshotText(child, depth + 1)).join('');
}

export function replaceSnapshot(result, replacement) {
  // Pinned upstream 1.10.1 ends snapshot/wait responses with the snapshot.
  // Diagnostics precede it; errors bypass this adapter and images pass through.
  const marker = '## Latest page snapshot\n';
  const index = result.content.findIndex(block => block.type === 'text' && block.text.includes(marker));
  if (index < 0) throw new Error('Unexpected upstream snapshot format; request a full snapshot.');
  return result.content.map((block, i) => i === index
    ? { ...block, text: block.text.slice(0, block.text.indexOf(marker)).trimEnd() + replacement }
    : block);
}

export function snapshotResult(params, result) {
  const { structuredContent: data, ...output } = result;
  const root = data?.snapshot;
  const scoped = params.scopeUid !== undefined ? root && findNode(root, params.scopeUid) : root;
  if (params.scopeUid !== undefined && !scoped) {
    return {
      ...output, isError: true,
      content: [{ type: 'text', text: `Scope UID ${JSON.stringify(params.scopeUid)} is absent from the fresh snapshot. Use the full snapshot below to select a current UID.` }, ...result.content],
    };
  }
  const metadata = {};
  if (params.match !== undefined || params.scopeUid !== undefined) {
    if (!scoped) throw new Error('No accessibility snapshot available for filtering.');
    const { roots, matches } = params.match ? findMatches(scoped, params.match) : { roots: [scoped], matches: [] };
    const heading = params.match ? `Matching page snapshot (${matches.length} matches)` : `Scoped page snapshot (${scoped.id})`;
    output.content = replaceSnapshot(result, `\n## ${heading}\n${roots.map(node => snapshotText(node)).join('')}`);
    if (params.match) metadata.matches = matches.map(({ id, role, name }) => ({ uid: id, ...(role !== undefined ? { role } : {}), ...(name !== undefined ? { name } : {}) }));
  }
  return { ...output, structuredContent: metadata };
}

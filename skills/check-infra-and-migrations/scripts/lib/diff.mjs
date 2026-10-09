// A unified diff, kept line by line: the rules for infrastructure files read
// what was added and what was removed, not the whole file.

// git ends a path that contains a space with a tab, and C-quotes a path with
// unusual bytes. Paths are read with core.quotePath=false, so only \t, \", \\ and \n are left to undo.
const path = (s) => {
  const t = s.replace(/\t$/, '');
  return /^".*"$/.test(t) ? t.slice(1, -1).replace(/\\([\\"tn])/g, (_, c) => ({ t: '\t', n: '\n' })[c] ?? c) : t;
};
const strip = (s, prefix) => (path(s).startsWith(prefix) ? path(s).slice(prefix.length) : path(s));

// -> [{ file, old_file?, status: added|modified|deleted|renamed, binary,
//       added: [{ n, text }],     n: line number at the head
//       removed: [{ at, text }] }]  at: the head line the removed line sat before
export function parsePatch(text) {
  const files = [];
  let cur = null;
  let n = 0;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/) || line.match(/^diff --git "a\/(.+)" "b\/(.+)"$/);
      cur = { file: m ? path(m[2]) : '', status: 'modified', binary: false, added: [], removed: [] };
      files.push(cur);
      n = 0;
      continue;
    }
    if (!cur) continue;
    if (n === 0) {
      if (line.startsWith('rename from ')) (cur.old_file = path(line.slice(12))), (cur.status = 'renamed');
      else if (line.startsWith('rename to ')) cur.file = path(line.slice(10));
      else if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.binary = true;
      else if (line.startsWith('--- ') && !line.startsWith('--- /dev/null') && cur.status === 'deleted') cur.file = strip(line.slice(4), 'a/');
      else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) cur.file = strip(line.slice(4), 'b/');
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      n = Math.max(Number(h[1]), 1);
      continue;
    }
    if (n === 0) continue;
    if (line.startsWith('+')) cur.added.push({ n: n++, text: line.slice(1) });
    else if (line.startsWith('-')) cur.removed.push({ at: n, text: line.slice(1) });
    else if (line.startsWith(' ')) n += 1;
    // "\ No newline at end of file" and anything else: not a line of the file.
  }
  return files;
}

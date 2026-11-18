export function rstHeadings(lines: readonly string[]) {
  const styles: string[] = [];
  const headings: { title: string; style: string; level: number; start: number; end: number }[] = [];
  const adornment = (line: string | undefined) => /^([=~^+*"'`:#\-])\1{2,}$/.test(line?.trimEnd() ?? '') ? line!.trimEnd()[0] : undefined;
  for (let index = 0; index < lines.length - 1; index++) {
    const title = lines[index]?.trimEnd();
    const underline = adornment(lines[index + 1]);
    if (!title || /^\s|^\.\./.test(title) || !/[\p{L}\p{N}]/u.test(title) || !underline) continue;
    const overline = adornment(lines[index - 1]) === underline;
    if (lines[index - (overline ? 2 : 1)]?.trim()) continue;
    if (lines[index + 1]!.trimEnd().length < title.length) continue;
    const style = underline + (overline ? 'overline' : '');
    if (!styles.includes(style)) styles.push(style);
    headings.push({ title, style, level: styles.indexOf(style), start: index + (overline ? 0 : 1), end: index + 2 });
    index++;
  }
  return headings;
}

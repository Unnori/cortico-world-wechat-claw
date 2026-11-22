import { describe, expect, it } from 'vitest';
import { prepareOutboundText } from '../src/outbound-text.ts';
import { splitSegments } from '../src/segment.ts';

const prepare = (text: string) => prepareOutboundText(text).text;

describe('出站 LaTeX', () => {
  it('将公式里的上下标、分数、根号、希腊字母与运算符转为 Unicode', () => {
    expect(prepare(String.raw`动能 $E_k=\frac{1}{2}mv^2$，$$\alpha_1 \times \beta^{n+1} \cdot \sqrt{x+y} \approx \sum_{i=0}^n \int x_i \mathrm{d}x$$`))
      .toBe('动能 Eₖ=1/2mv²，α₁ × βⁿ⁺¹ · √(x+y) ≈ ∑ᵢ₌₀ⁿ ∫ xᵢ dx');
    expect(prepare(String.raw`$\sqrt[3]{8} \neq 3 \geq 2 \leq 5$，$ \text{part_no} \mathrm{kg} $`))
      .toBe('³√8 ≠ 3 ≥ 2 ≤ 5，part_no kg');
  });

  it('将单独或放在上标里的圆圈转换为度数符号', () => {
    expect(prepare(String.raw`$5^(\circ)C$，$5^\circ C$，$5^{\circ}C$，$5^{(\circ)}C$，$5\circ C$`))
      .toBe('5°C，5° C，5°C，5°C，5° C');
  });

  it('转换单双向箭头与逻辑蕴含', () => {
    expect(prepare(String.raw`$A \Rightarrow B \Leftrightarrow C \Leftarrow D \leftrightarrow E \iff F \implies G \impliedby H \to I$`))
      .toBe('A ⇒ B ⇔ C ⇐ D ↔ E ⇔ F ⇒ G ⇐ H → I');
  });

  it('用括号标明多字符根式的范围，并保留无法转成 Unicode 的上标', () => {
    expect(prepare(String.raw`$f_0 = \frac{1}{2\pi\sqrt{LC}}$，$\int_0^T$`))
      .toBe('f₀ = 1/(2π√(LC))，∫₀^T');
    expect(prepare(String.raw`$\sqrt{L}C$`)).toBe('√LC');
  });

  it('保留复杂命令和内容，剥离美元分隔符', () => {
    const math = String.raw`$$\begin{aligned}
x &= \unknown{x}{y} \\
y &= a
\end{aligned}$$`;
    const result = prepare(math);
    expect(result).not.toContain('$');
    expect(result).toContain(String.raw`\unknown(x)y`);
    expect(result).toContain('y &= a');
  });

  it.each([
    '原价 $12.99，现在 $9.99，再加 US$2 运费。',
    '价格 $12.00 至 $20，或者 $10–$14。',
    'A discount of $15 or $20 depending on the date.',
    'Cost is $12 + $ shipping.',
    '价格仍是 $20，尾部美元符号 $',
    String.raw`escaped \$12.50 and \$x^2\$`,
  ])('保护货币与转义美元符号 %s', (text) => {
    expect(prepare(text)).toBe(text);
  });

  it('价格、转义符号和公式可以同时出现', () => {
    expect(prepare(String.raw`价格 $12.50，计算 $x^2$；$$\text{\$20}\times 2$$`))
      .toBe('价格 $12.50，计算 x²；＄20× 2');
    expect(prepare('价格 $12.50，见 fee_note；公式 $n!$')).toBe('价格 $12.50，见 fee_note；公式 n!');
  });

  it('保留围栏与任意长度的行内代码，切分也不会进入其内部', () => {
    const block = ['```md', '1. **$t^2$**', '    续行。', '```'].join('\n');
    const inline = '``$z^2$ ` !``';
    const prepared = prepareOutboundText([block, inline + ' 与 $x_2$。'].join('\n'));
    expect(prepared.text).toBe(block + '\n' + inline + ' 与 x₂。');
    expect(splitSegments(prepared.text, prepared.boundaries)).toEqual([block, inline + ' 与 x₂']);
    expect(prepare('~~~tex\n$x^3$\n')).toBe('~~~tex\n$x^3$\n');
    expect(prepare('` unmatched\n\n$x^2$\n\nend `')).toBe('` unmatched\n\nx²\n\nend `');
  });

  it('公式本身的换行和句号不触发语义分段', () => {
    const prepared = prepareOutboundText('$$\\text{例句。}\\\\x^2$$\n下一段。');
    expect(splitSegments(prepared.text, prepared.boundaries)).toEqual(['例句。\nx²', '下一段']);
  });
});

describe('出站 Markdown 列表', () => {
  it('拍平有序、无序列表里的续行，保留标题、段落和独立条目', () => {
    const input = [
      '1. **第一项**', '   第一行', '   第二行', '', '   第二段',
      '2. **第二项：**', '   最后一条正文', '- **收尾**', '  结语',
    ].join('\r\n');
    const prepared = prepareOutboundText(input);
    expect(splitSegments(prepared.text, prepared.boundaries)).toEqual([
      '1. **第一项**：第一行 第二行　第二段',
      '2. **第二项：** 最后一条正文',
      '- **收尾**：结语',
    ]);
  });

  it('一条列表也保留有序编号，并在拍平后转换续行里的公式', () => {
    const prepared = prepareOutboundText('2. **公式**\n   $y_i^2$。仍在同一条。');
    expect(splitSegments(prepared.text, prepared.boundaries)).toEqual(['2. **公式**：yᵢ²。仍在同一条']);
  });

  it('保留嵌套列表、围栏代码与列表里的缩进代码', () => {
    const text = [
      '- 外层', '  - 内层', '',
      '        const x = 2;',
      '  ```md', '  1. **项目**', '     $x^2$', '  ```',
    ].join('\n');
    expect(prepare(text)).toBe(text);
  });
});

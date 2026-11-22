const SYMBOLS: Readonly<Record<string, string>> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ϵ', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', approx: '≈', sim: '∼', equiv: '≡', circ: '°',
  neq: '≠', ne: '≠', le: '≤', leq: '≤', ge: '≥', geq: '≥', lt: '<', gt: '>', propto: '∝',
  int: '∫', iint: '∬', iiint: '∭', oint: '∮', sum: '∑', prod: '∏', infty: '∞', partial: '∂', nabla: '∇',
  to: '→', rightarrow: '→', gets: '←', leftarrow: '←', leftrightarrow: '↔', mapsto: '↦',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', impliedby: '⇐', iff: '⇔',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨', perp: '⊥', parallel: '∥',
  sin: 'sin', cos: 'cos', tan: 'tan', log: 'log', ln: 'ln', lim: 'lim', max: 'max', min: 'min',
  dots: '…', ldots: '…', cdots: '⋯', lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩',
  left: '', right: '', limits: '', nolimits: '', displaystyle: '', textstyle: '',
  quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', ' ': ' ', '!': '',
  '\\': '\n',
};

const TEXT_COMMANDS = new Set(['text', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'operatorname']);
const FRACTIONS = new Set(['frac', 'dfrac', 'tfrac']);

const scripts = {
  '^': ['0123456789+-=()abcdefghijklmnoprstuvwxyz', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ'],
  '_': ['0123456789+-=()aehijklmnoprstuvxβγρφχ', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ'],
} as const;

function script(symbol: '^' | '_', value: string): string {
  if (symbol === '^' && /^(?:°|\(\s*°\s*\))$/.test(value.trim())) return '°';
  const [from, to] = scripts[symbol];
  const chars = Array.from(value);
  if (chars.length && chars.every(ch => from.includes(ch))) {
    return chars.map(ch => to[from.indexOf(ch)]).join('');
  }
  return symbol + (chars.length === 1 ? value : '(' + value + ')');
}

const parenthesize = (value: string) => /^[\p{L}\p{N}.]+$/u.test(value) ? value : '(' + value + ')';

export function looksLikeMath(body: string, display: boolean): boolean {
  const content = body.trim();
  if (!content) return false;
  if (display) return true;
  // A price prefix may reach the next unrelated dollar sign. Require a math
  // token immediately after a leading amount before consuming that pair.
  const amount = /^[+-]?\d+(?:[,.]\d+)*[%％]?/.exec(content);
  if (amount && !/^\s*[+\-−*/=<>|^_×÷±≤≥≠\\]/.test(content.slice(amount[0].length))) return false;
  if (/\\[A-Za-z]+|[_^{}]/.test(content)) return true;
  if (/^[\p{Script=Latin}\p{Script=Greek}\p{N}]{1,2}$/u.test(content)) return true;
  return /^[\p{L}\p{N}\s.,()+*/=<>|+\-−×÷±≤≥≠!]+$/u.test(content)
    && /[+*/=<>|−×÷±≤≥≠!]|\S\s*-\s*\S/.test(content)
    && !/[+*/=<>|\-−×÷±≤≥≠]$/.test(content)
    && !/\p{L}\s+\p{L}/u.test(content);
}

/** Render common TeX atoms locally. Keep names and arguments of unfamiliar commands visible. */
export function latexToUnicode(body: string): string {
  const tokens: string[] = body.match(/\\(?:[A-Za-z]+|[\s\S])|[\s\S]/gu) ?? [];
  let position = 0;

  function atom(depth: number, literal = false): string {
    const token = tokens[position++]!;
    if (depth > 64) return token + tokens.splice(position).join('');
    if (token === '{') {
      let content = '';
      while (position < tokens.length && tokens[position] !== '}') content += atom(depth + 1, literal);
      if (tokens[position] !== '}') return '{' + content;
      position += 1;
      return content;
    }
    if (!literal && (token === '^' || token === '_')) {
      const opening = nextNonSpace(position);
      if (token === '^' && tokens[opening] === '(') {
        const circle = nextNonSpace(opening + 1);
        const closing = nextNonSpace(circle + 1);
        // Models sometimes write ^(\circ) in place of the braced TeX superscript.
        if (tokens[circle] === '\\circ' && tokens[closing] === ')') {
          position = closing + 1;
          return '°';
        }
      }
      const value = argument(depth);
      return value === undefined ? token : script(token, value);
    }
    if (token[0] !== '\\') return token;
    const name = token.slice(1);
    if (FRACTIONS.has(name)) {
      const numerator = argument(depth);
      if (numerator === undefined) return token;
      const denominator = argument(depth);
      if (denominator === undefined) return token + ' ' + numerator;
      return parenthesize(numerator) + '/' + parenthesize(denominator);
    }
    if (name === 'sqrt') {
      let degree = '';
      if (tokens[position] === '[') {
        const end = tokens.indexOf(']', position + 1);
        if (end !== -1) {
          degree = script('^', tokens.slice(position + 1, end).join(''));
          position = end + 1;
        }
      }
      const radicand = argument(depth);
      if (radicand === undefined) return degree + '√';
      const root = Array.from(radicand).length === 1 ? parenthesize(radicand) : '(' + radicand + ')';
      return degree + '√' + root;
    }
    if (TEXT_COMMANDS.has(name)) return argument(depth, name === 'text') ?? name;
    if (Object.hasOwn(SYMBOLS, name)) return SYMBOLS[name]!;
    if (/^[#$%&_{}]$/.test(name)) return name;
    const next = tokens[position];
    return token + (next === '{' ? '(' + atom(depth + 1) + ')' : '');
  }

  function nextNonSpace(index: number): number {
    while (index < tokens.length && /^\s$/.test(tokens[index]!)) index += 1;
    return index;
  }

  function argument(depth: number, literal = false): string | undefined {
    position = nextNonSpace(position);
    if (position === tokens.length || tokens[position] === '}') return undefined;
    return atom(depth + 1, literal);
  }

  let result = '';
  while (position < tokens.length) result += atom(0);
  return result.trim() || body.trim();
}

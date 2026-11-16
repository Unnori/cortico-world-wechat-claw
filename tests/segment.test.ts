/**
 * 语义分段与延时的纯函数行为。
 *
 * 这里不碰网络、不碰 World，只验「怎么切」和「等多久」——这两件事最容易出错，
 * 也最值得用真字符串一条条钉住。
 */
import { describe, expect, it } from 'vitest';

import { segmentDelayMs, splitSegments } from '../src/segment.ts';

describe('换行优先', () => {
  it('有换行就只按换行拆，段内句号不参与分段', () => {
    // 这正是「换行与句号同时出现」的情形：只拆一次，不额外按句号拆。
    const text = '俺给你分三层：\n插件成熟度第一。文档齐全。\nPython 那条路最舒服。';
    expect(splitSegments(text)).toEqual([
      '俺给你分三层：',
      '插件成熟度第一。文档齐全',
      'Python 那条路最舒服',
    ]);
  });

  it('换行前的句号被去掉（段内句号保留）', () => {
    // 操作者的要求：换行与句号同时出现时，句号也要删。
    // 「插件成熟度第一。文档齐全。」里的第一个句号在句子中间，必须留着。
    const text = '俺给你分三层：\n插件成熟度第一。文档齐全。\nPython 那条路最舒服。';
    expect(splitSegments(text)).toEqual([
      '俺给你分三层：',
      '插件成熟度第一。文档齐全',
      'Python 那条路最舒服',
    ]);
  });

  it('段尾连续的句号一起清干净', () => {
    expect(splitSegments('说完了。。\n接着讲')).toEqual(['说完了', '接着讲']);
    expect(splitSegments('说完了.．。\n接着讲')).toEqual(['说完了', '接着讲']);
  });

  it('最后一段的段尾句号同样去掉', () => {
    expect(splitSegments('甲。\n乙。')).toEqual(['甲', '乙']);
  });

  it('换行后紧跟句号时不会留下空段', () => {
    expect(splitSegments('甲\n。\n乙')).toEqual(['甲', '乙']);
  });

  it('多个连续换行只算一次，不产生空段', () => {
    expect(splitSegments('甲\n\n\n乙')).toEqual(['甲', '乙']);
  });

  it('换行开头的文本不会留下空首段', () => {
    expect(splitSegments('\n甲\n乙')).toEqual(['甲', '乙']);
  });
});

describe('没有换行时按句号拆', () => {
  it('中文句号被删掉', () => {
    expect(splitSegments('今天下雨了。我带了伞。')).toEqual(['今天下雨了', '我带了伞']);
  });

  it('全角句点也算句号', () => {
    expect(splitSegments('甲．乙．')).toEqual(['甲', '乙']);
  });

  it('ASCII 句点只在后面跟空白或结尾时才拆', () => {
    // 断句用的句点：删掉。
    expect(splitSegments('Done. Next one.')).toEqual(['Done', 'Next one']);
    // 小数、域名、文件名：不拆也不删。
    expect(splitSegments('现在 3.14，涨了 0.5%')).toEqual(['现在 3.14，涨了 0.5%']);
    expect(splitSegments('看 docs.nonebot.dev 那份')).toEqual(['看 docs.nonebot.dev 那份']);
    expect(splitSegments('文件名 report.2026.11.md')).toEqual(['文件名 report.2026.11.md']);
  });
});

describe('情绪标点只拆不删', () => {
  it('感叹号与问号保留', () => {
    expect(splitSegments('真的假的？太好了！')).toEqual(['真的假的？', '太好了！']);
  });

  it('半角与省略号、波浪号也保留', () => {
    expect(splitSegments('why? ok! 嗯… 好～')).toEqual(['why?', 'ok!', '嗯…', '好～']);
  });

  it('「！？」成对出现只算一处', () => {
    expect(splitSegments('太离谱了！？')).toEqual(['太离谱了！？']);
  });

  it.each<[string, string[]]>([
    ['好呀~♡', ['好呀~♡']],
    ['好呀\\~♡ ......接着说', ['好呀\\~♡ ......', '接着说']],
    ['嗯……再想想', ['嗯……', '再想想']],
    ['等等...... 好了', ['等等......', '好了']],
    ['等等.. 好了', ['等等..', '好了']],
    ['真的？！太好了!!!', ['真的？！', '太好了!!!']],
    ['好～~♡!?……下次见', ['好～~♡!?……', '下次见']],
    ['好呀~❤️‍🔥下次见', ['好呀~❤️‍🔥', '下次见']],
    ['好呀~👍🏽下次见', ['好呀~👍🏽', '下次见']],
    ['她说“好呀！”然后走了', ['她说“好呀！”', '然后走了']],
    ['你好！“再见”', ['你好！', '“再见”']],
    ['你好！（再见）', ['你好！', '（再见）']],
    ['多少钱？￥50', ['多少钱？', '￥50']],
    ['......', ['......']],
    ['~♡ ......', ['~♡ ......']],
  ])('连续符号完整保留：%s', (text, expected) => {
    expect(splitSegments(text)).toEqual(expected);
  });

  it('旗帜 emoji 的不可见标签序列跟随底字符完整保留', () => {
    const flag = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}';
    expect(splitSegments(`好呀~${flag}下次见`)).toEqual([`好呀~${flag}`, '下次见']);
  });

  it('换行清理句号时保留整串省略号，包括最后一段', () => {
    expect(splitSegments('等等......\n想想......。\n好了……\n再等等......')).toEqual([
      '等等......', '想想......', '好了……', '再等等......',
    ]);
  });

  it('省略号不抢占真正句号的切分优先级', () => {
    expect(splitSegments('嗯……想想......再说。好！')).toEqual(['嗯……想想......再说', '好！']);
    expect(splitSegments('Wait...... Next. Done.')).toEqual(['Wait...... Next', 'Done']);
  });

  it('省略号识别不拆开相对路径', () => {
    expect(splitSegments('打开 ../file.txt 或 ..\\file.txt')).toEqual(['打开 ../file.txt 或 ..\\file.txt']);
  });

  it('有句号时情绪标点不参与，句号优先', () => {
    expect(splitSegments('你好！我来了。')).toEqual(['你好！我来了']);
  });
});

describe('没有分隔符就不拆', () => {
  it('一句话原样返回', () => {
    expect(splitSegments('就是这一句没有标点')).toEqual(['就是这一句没有标点']);
  });

  it('空白文本返回空数组', () => {
    expect(splitSegments('   ')).toEqual([]);
  });

  it('只有分隔符时返回空数组', () => {
    expect(splitSegments('。。。')).toEqual([]);
  });
});

describe('真实长文本', () => {
  it('四段换行的回复正好拆成四段', () => {
    const text = [
      '生态最好这个得看你想要啥喵，俺给你分三层：',
      '插件数量和成熟度，Koishi 压倒性第一——插件市场几百个，文档中文齐全。缺点是要 Node，部署比 Python 重一点。',
      'Python 生态那条路是 NoneBot2 最舒服，跟 OneBot 生态接得最顺。',
      '纯玩梗聊天那种，TRSS 云崽的娱乐插件最多；但它是娱乐向框架。',
      '所以俺拍板：你要是就干「监测 DeepSeek + 崩服发图」这一件事，nonebot2。',
    ].join('\n');
    const parts = splitSegments(text);
    expect(parts).toHaveLength(5);
    // 段内句号保留（因为这一篇是换行优先）。
    expect(parts[1]).toContain('。');
    expect(parts[4]).not.toContain('\n');
  });
});

describe('按字数停顿', () => {
  it('短句和特长段立即发送，边界按 Unicode 字符计数', () => {
    for (const text of ['', '字'.repeat(20), '🐟'.repeat(20), '字'.repeat(301)]) {
      expect(segmentDelayMs(text)).toBe(0);
    }
    expect(segmentDelayMs('🐟'.repeat(21))).toBeGreaterThan(0);
  });

  it('中等长度稍等，长句等待更多，各档由同一个聊天节奏控制', () => {
    const medium = segmentDelayMs('字'.repeat(21));
    expect(segmentDelayMs('字'.repeat(80))).toBe(medium);
    const long = segmentDelayMs('字'.repeat(81));
    expect(long).toBeGreaterThan(medium);
    expect(segmentDelayMs('字'.repeat(300))).toBe(long);
    expect(segmentDelayMs('字'.repeat(81), 2)).toBe(long * 2);
    expect(segmentDelayMs('字'.repeat(81), 0)).toBe(0);
  });

  it('无效配置采用默认节奏，负值不等待，过大值限制在面板上限', () => {
    const text = '字'.repeat(50);
    expect(segmentDelayMs(text, NaN)).toBe(segmentDelayMs(text));
    expect(segmentDelayMs(text, -1)).toBe(0);
    expect(segmentDelayMs(text, 100)).toBe(segmentDelayMs(text, 10));
  });
});

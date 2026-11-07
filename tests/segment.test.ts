/**
 * 语义分段与延时的纯函数行为。
 *
 * 这里不碰网络、不碰 World，只验「怎么切」和「等多久」——这两件事最容易出错，
 * 也最值得用真字符串一条条钉住。
 */
import { describe, expect, it } from 'vitest';

import { segmentDelayMs, segmentDelayOf, splitSegments } from '../src/segment.ts';

describe('换行优先', () => {
  it('有换行就只按换行拆，句号不参与', () => {
    // 这正是「换行与句号同时出现」的情形：只拆一次，不额外拆句号。
    const text = '俺给你分三层：\n插件成熟度第一。文档齐全。\nPython 那条路最舒服。';
    expect(splitSegments(text)).toEqual([
      '俺给你分三层：',
      '插件成熟度第一。文档齐全。',
      'Python 那条路最舒服。',
    ]);
  });

  it('换行紧邻的句号留在段内，因为换行优先时段内不再拆', () => {
    // 换行按一次算：句号跟着前一段走，不会被删也不会再拆一次。
    expect(splitSegments('第一段。\n第二段。')).toEqual(['第一段。', '第二段。']);
  });

  it('换行前只有句号时，段尾就只剩句号，正常保留', () => {
    expect(splitSegments('说完了。\n接着讲')).toEqual(['说完了。', '接着讲']);
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

describe('延时口径', () => {
  it('固定间隔直接换算成毫秒', () => {
    expect(segmentDelayMs({ mode: 'fixed', seconds: 2 }, 0)).toBe(2000);
    expect(segmentDelayMs({ mode: 'fixed', seconds: 0 }, 3)).toBe(0);
  });

  it('随机区间落在上下界之间', () => {
    const delay = { mode: 'random' as const, min: 1, max: 4 };
    expect(segmentDelayMs(delay, 0, () => 0)).toBe(1000);
    expect(segmentDelayMs(delay, 0, () => 1)).toBe(4000);
    expect(segmentDelayMs(delay, 0, () => 0.5)).toBe(2500);
  });

  it('随机上下界写反了自动换过来', () => {
    expect(segmentDelayMs({ mode: 'random', min: 5, max: 2 }, 0, () => 0)).toBe(2000);
    expect(segmentDelayMs({ mode: 'random', min: 5, max: 2 }, 0, () => 1)).toBe(5000);
  });

  it('负数与 NaN 归零，不会算出负等待', () => {
    expect(segmentDelayMs({ mode: 'fixed', seconds: -1 }, 0)).toBe(0);
    expect(segmentDelayMs({ mode: 'random', min: -2, max: -1 }, 0, () => 0.5)).toBe(0);
  });

  it('从配置段取口径，负数当 0', () => {
    expect(segmentDelayOf({ segmentDelayMode: 'fixed', segmentDelayFixedSec: 3 }))
      .toEqual({ mode: 'fixed', seconds: 3 });
    expect(segmentDelayOf({ segmentDelayMode: 'random', segmentDelayMinSec: 1, segmentDelayMaxSec: 5 }))
      .toEqual({ mode: 'random', min: 1, max: 5 });
    expect(segmentDelayOf({ segmentDelayMode: 'fixed', segmentDelayFixedSec: -4 }))
      .toEqual({ mode: 'fixed', seconds: 0 });
    // 没写模式时按固定处理。
    expect(segmentDelayOf({})).toEqual({ mode: 'fixed', seconds: 0 });
  });
});

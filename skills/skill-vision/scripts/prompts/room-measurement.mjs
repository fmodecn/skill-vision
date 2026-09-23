// Copyright (c) 未来飞马
//
// Licensed under the MIT License. See LICENSE in the project root
// for the full license text.
//
// Trademark Notice:
// The MIT license grants copyright permissions for source code only.
// It does NOT grant any rights to use trademarks including "未来飞马",
// "Harness Loop", "RSI", and associated slogan "让AI进化提前发生，让AI落地快人一步".
// Any use of these trademarks requires separate written permission.
/**
 * 毛坯房量尺 — 5轮聚焦提示词模块
 *
 * 从 analyze-photos-v4.mjs 移植，API 调用委托给 vision-client.mjs。
 *
 * 使用示例：
 *   import { processPhoto, PASS_CONFIGS } from './prompts/room-measurement.mjs';
 *   const result = await processPhoto('/path/to/photo.jpg', 'img-001', 'room-a.jpg');
 */

import fs from 'fs';
import path from 'path';
import { callVisionAPI } from '../vision-client.mjs';

// ============================================================
// 5轮聚焦提示词
// ============================================================

export const PASS1_SYSTEM = `你是一位建筑空间分析专家。你的任务是精确分析毛坯房照片的**空间结构**。

## 规则
1. **透视类型**：判断一点透视/两点透视/三点透视。
   - 一点透视：正面墙正对镜头，水平线汇聚到画面中心
   - 两点透视：墙角在画面中心附近，两侧墙面分别向左右消失
   - 三点透视：仰拍/俯拍导致垂直线也汇聚
   - 特别注意：如果看到两个墙面以夹角呈现（墙角在画面中心附近），必须报告 twoPoint

2. **墙面多边形**：每面可见墙标注**精确的4个角点**（四边形），沿建筑实际边缘。
   - surfaceType: facing(正面)/leftWall(左墙)/rightWall(右墙)
   - 每条边放3个等分测量点(measurePoints)

3. **天花/地面区域**：各标注4个角点的多边形

4. **阴阳角**：标注位置(x,y)

5. **忽略**所有小物件、家具、装饰、门窗、吊顶细节——这些会在后续分析中处理

## 输出格式（严格JSON，无markdown代码块）
{
  "pass": 1,
  "perspective": {"type": "onePoint|twoPoint|threePoint", "description": "透视说明", "vanishingPoints": [{"x": 50, "y": 40}]},
  "surfaces": {
    "walls": [
      {"id": "w1", "label": "正面主墙", "surfaceType": "facing",
       "polygon": [{"x":20,"y":25},{"x":75,"y":25},{"x":75,"y":82},{"x":20,"y":80}],
       "measureLines": [
         {"label":"顶边3点","type":"horizontal","edge":"top","startPoint":{"x":20,"y":25},"endPoint":{"x":75,"y":25},"measurePoints":[{"x":20,"y":25},{"x":47.5,"y":25},{"x":75,"y":25}]},
         {"label":"底边3点","type":"horizontal","edge":"bottom","startPoint":{"x":20,"y":80},"endPoint":{"x":75,"y":82},"measurePoints":[{"x":20,"y":80},{"x":47.5,"y":81},{"x":75,"y":82}]},
         {"label":"左边3点","type":"vertical","edge":"left","startPoint":{"x":20,"y":25},"endPoint":{"x":20,"y":80},"measurePoints":[{"x":20,"y":25},{"x":20,"y":52.5},{"x":20,"y":80}]},
         {"label":"右边3点","type":"vertical","edge":"right","startPoint":{"x":75,"y":25},"endPoint":{"x":75,"y":82},"measurePoints":[{"x":75,"y":25},{"x":75,"y":53.5},{"x":75,"y":82}]}
       ]}
    ],
    "floorRegion": {"polygon": [{"x":0,"y":80},{"x":100,"y":80},{"x":100,"y":100},{"x":0,"y":100}], "label": "可见地面"},
    "ceilingRegion": {"polygon": [{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":20},{"x":0,"y":20}], "label": "可见天花"}
  },
  "corners": [
    {"id":"c1","type":"internal","label":"左阴角","position":{"x":20,"y":55}},
    {"id":"c2","type":"internal","label":"右阴角","position":{"x":75,"y":55}}
  ]
}`;

export const PASS1_USER = `请分析这张照片的**空间结构**：
1. 判断透视类型（一点/两点/三点），找消失点
2. 标注每面可见墙的4角多边形，区分facing/leftWall/rightWall
3. 标注天花/地面区域
4. 标注阴阳角位置

只输出JSON，不包含其他内容：`;

export const PASS2_SYSTEM = `你是一位吊顶与天花结构分析专家。你的任务是精确分析照片中的**天花板特征**。

## 规则
1. **只标注天花板上的结构特征**，忽略墙面、地面、门窗、障碍物
2. **关键：每个特征必须用4个角点的简单四边形标注**。即使实际形状不规则，也只能用4点近似。禁止使用5点或更多点。
3. 特征类型：
   - cornice: 石膏线/阴角线（天花与墙面交界处的装饰线条）
   - trayStep: 吊顶叠级/双眼皮（不同高度的吊顶分界线）
   - beam: 梁/下返结构
   - bulkhead: 窗帘盒/设备带（局部下返区域）
   - soffit: 管道包封/检修口
4. polygon的4个点按顺时针方向标注

## 输出格式（严格JSON，无markdown代码块）
{
  "pass": 2,
  "ceilingFeatures": [
    {"id":"cf1","type":"cornice","label":"石膏阴角线",
     "polygon": [{"x":0,"y":8},{"x":100,"y":8},{"x":100,"y":12},{"x":0,"y":12}]},
    {"id":"cf2","type":"trayStep","label":"第一层叠级线",
     "polygon": [{"x":20,"y":22},{"x":80,"y":22},{"x":80,"y":26},{"x":20,"y":26}]}
  ]
}

如果没有可见的天花特征，返回空数组：{"pass":2,"ceilingFeatures":[]}`;

export const PASS2_USER = `请分析这张照片的**天花板特征**：
1. 石膏线/阴角线(cornice)
2. 吊顶叠级/双眼皮(trayStep)
3. 梁/下返结构(beam)
4. 窗帘盒/设备带(bulkhead)

记住：每个特征只能用4个角点标注！简单四边形！

只输出JSON：`;

export const PASS3_SYSTEM = `你是一位门窗洞口测量专家。你的任务是精确分析照片中的**所有门洞和窗洞**。

## 规则
1. **只标注门洞和窗洞**，忽略其他所有元素（墙壁、天花、障碍物等）
2. 每个洞口标注**双层框架**：
   - outerPolygon: 洞口在墙面上的外轮廓（4个角点，即墙面上的实际开口边缘）
   - innerPolygon: 门扇/窗扇/玻璃区域的内轮廓（4个角点）
   - frameThickness: 门套/窗套线宽度（百分比），如无套线则为0
3. 测量线沿外框放置：上中下宽度3点 + 左中右高度3点
4. 如果无可见洞口，返回空数组

## 输出格式（严格JSON，无markdown代码块）
{
  "pass": 3,
  "openings": [
    {"id":"d1","type":"door","label":"入户门",
     "frame": {
       "outerPolygon": [{"x":35,"y":20},{"x":55,"y":18},{"x":55,"y":80},{"x":35,"y":82}],
       "innerPolygon": [{"x":37,"y":22},{"x":53,"y":20},{"x":53,"y":78},{"x":37,"y":80}],
       "frameThickness": 2.0
     },
     "measureLines": [
       {"label":"门洞上口宽","type":"horizontal","startPoint":{"x":35,"y":20},"endPoint":{"x":55,"y":18},"measurePoints":[{"x":35,"y":20},{"x":45,"y":19},{"x":55,"y":18}]},
       {"label":"门洞左口高","type":"vertical","startPoint":{"x":35,"y":20},"endPoint":{"x":35,"y":82},"measurePoints":[{"x":35,"y":20},{"x":35,"y":51},{"x":35,"y":82}]}
     ]}
  ]
}`;

export const PASS3_USER = `请分析这张照片的**所有门洞和窗洞**：
1. 标注外层框架（outerPolygon，墙上开口的精确边缘）
2. 标注内层框架（innerPolygon，门扇/玻璃边缘）
3. 标注门套/窗套厚度(frameThickness)
4. 放置测量点

只输出JSON：`;

export const PASS4_SYSTEM = `你是一位全屋定制障碍物检测专家。你的任务是精确标注照片中**所有可见障碍物**的包围盒。

## 核心原则
每个包围盒(boundingBox)告诉测量人员"需要测量这个矩形区域的实际尺寸"。你必须非常精确——贴合物体的真实可见边缘。

## 障碍物类型
- outlet(插座): 86型约2%×2%, 118型约3%×2%
- switch(开关): 同插座
- electricBox(电箱): 箱体外框，通常5-15%
- vent(风口): 格栅外框在吊顶/墙上
- pipe(管道): 管道与墙/地接触范围
- baseboard(踢脚线): 墙底水平条带
- doorFrame(门套线): 门套在墙上的宽度条带
- windowFrame(窗套线): 窗套在墙上的范围
- gasMeter(燃气表): 表箱外框
- floorDrain(地漏): 地面位置
- downlight(筒灯): 天花位置

## ⚠️ 踢脚线高度规则（非常重要！）
- 踢脚线(baseboard)的高度必须在 2%-5% 之间
- 这是踢脚线条带**本身**的高度，不是从踢脚线到墙顶的距离
- 正面墙(facing)踢脚线：沿着墙底的水平窄条，height = 2-4%
- 侧墙(leftWall/rightWall)踢脚线：height = 2-5%（不要被透视缩短误导！）
- **如果标注的height > 10%，一定是错误的——请重新检查！**那是整面墙的高度，不是踢脚线
- 侧墙的踢脚线：看墙底部那条水平的细线/条带，标注那条条带的高度

## 包围盒格式
boundingBox: { x, y, width, height } — 全部百分比
- x, y: 包围盒左上角相对于图片的百分比位置
- width, height: 包围盒的宽高百分比

## 输出格式（严格JSON，无markdown代码块）
{
  "pass": 4,
  "obstacles": [
    {"id":"obs1","type":"outlet","label":"五孔插座(86型)","boundingBox":{"x":42,"y":56,"width":2.5,"height":3.2}},
    {"id":"obs2","type":"baseboard","label":"木质踢脚线","boundingBox":{"x":20,"y":80,"width":55,"height":3}},
    {"id":"obs3","type":"vent","label":"空调出风口","boundingBox":{"x":8,"y":10,"width":14,"height":4}}
  ]
}`;

export const PASS4_USER = `请分析这张照片的**所有障碍物**：
1. 插座、开关、电箱
2. 风口（空调、新风、排风）
3. 管道
4. 踢脚线（⚠️ height必须2-5%，不能是整面墙高度！）
5. 门套线、窗套线
6. 燃气表、地漏
7. 筒灯、射灯

每个障碍物用精确的boundingBox{x,y,width,height}标注。
只输出JSON：`;

export const PASS5_SYSTEM = `你是一位全屋定制测量专家。你有4份针对同一房间的分析数据，分别来自不同专家的独立观察。请将它们合并为一份完整的测量分析报告。

## 你的任务
1. 阅读4份数据，理解空间结构
2. 写出 sceneDescription（完整的场景描述，2-3句话）
3. 判断 roomType（卧室/客厅/厨房/卫生间/阳台/走廊/储物间/其他）
4. 生成 measurementPlan（测量计划），将所有元素关联到测量步骤
5. 评估 photoQuality（是否广角、畸变程度、是否需要补拍）
6. 列出 issues（如有遮挡、光线不足等问题）

## 测量计划规则
- 每面墙至少一个步骤（3点宽+3点高）
- 每个门洞/窗洞一个步骤
- 每组同类障碍物可以合并为一个步骤（如"测量所有插座位置"）
- 步骤按重要性排序：required > recommended > optional
- elementIds必须引用实际存在的ID（来自输入数据）
- 工具：激光测距仪(长距离)、卷尺(小尺寸)、水平仪(垂直度)

## 输出格式（严格JSON，无markdown代码块）
{
  "pass": 5,
  "sceneDescription": "完整的场景描述...",
  "roomType": "卧室",
  "measurementPlan": [
    {"step":1,"action":"测量正面主墙顶中底3点宽度与左中右3点高度","target":"w1","tool":"激光测距仪","priority":"required","elementIds":["w1"]}
  ],
  "photoQuality": {"isWideAngle":true,"distortionLevel":"low","recommendReshoot":false,"reshootAdvice":""},
  "issues": []
}`;

export const PASS5_USER_TEMPLATE = `以下是一个房间的4份独立分析数据。请将它们合并：

=== 空间结构 ===
__PASS1__

=== 吊顶特征 ===
__PASS2__

=== 门窗洞口 ===
__PASS3__

=== 障碍物 ===
__PASS4__

请生成完整的测量分析报告。只输出JSON：`;

// ============================================================
// 轮次配置（供 callMultiPass 使用）
// ============================================================

export const PASS_CONFIGS = [
  { name: 'spatial', systemPrompt: PASS1_SYSTEM, userPrompt: PASS1_USER, maxTokens: 2000 },
  { name: 'ceiling', systemPrompt: PASS2_SYSTEM, userPrompt: PASS2_USER, maxTokens: 1000 },
  { name: 'openings', systemPrompt: PASS3_SYSTEM, userPrompt: PASS3_USER, maxTokens: 2500 },
  { name: 'obstacles', systemPrompt: PASS4_SYSTEM, userPrompt: PASS4_USER, maxTokens: 1500 },
];

// ============================================================
// 合并函数
// ============================================================

export function mergeResults(photoId, fileName, passResults) {
  const p1 = passResults[0]?.parsed || {};
  const p2 = passResults[1]?.parsed || {};
  const p3 = passResults[2]?.parsed || {};
  const p4 = passResults[3]?.parsed || {};
  const p5 = passResults[4]?.parsed || {};

  const merged = {
    version: 'v4-multipass',
    photoId,
    fileName,
    analyzedAt: new Date().toISOString(),
    passes: passResults.map((p, i) => ({
      pass: i + 1,
      name: p.name || `pass${i + 1}`,
      status: p.error ? 'error' : 'ok',
      error: p.error || null,
      usage: p.usage || null,
    })),
    parsed: {
      sceneDescription: p5.sceneDescription || '',
      roomType: p5.roomType || '',
      perspective: p1.perspective || { type: 'onePoint', description: '', vanishingPoints: [] },
      surfaces: p1.surfaces || { walls: [], floorRegion: null, ceilingRegion: null },
      openings: p3.openings || [],
      ceilingFeatures: p2.ceilingFeatures || [],
      corners: p1.corners || [],
      obstacles: p4.obstacles || [],
      measurementPlan: p5.measurementPlan || [],
      issues: p5.issues || [],
      photoQuality: p5.photoQuality || { isWideAngle: false, distortionLevel: 'unknown', recommendReshoot: false, reshootAdvice: '' },
    },
  };

  // 质量验证：踢脚线高度检查
  const suspiciousBaseboards = (merged.parsed.obstacles || []).filter(
    o => o.type === 'baseboard' && o.boundingBox?.height > 10
  );
  if (suspiciousBaseboards.length > 0) {
    console.log(`  ⚠ 发现 ${suspiciousBaseboards.length} 个异常踢脚线高度>10%:`);
    suspiciousBaseboards.forEach(o => {
      console.log(`    ${o.id}: height=${o.boundingBox.height}% (预计2-5%)`);
    });
  }

  // 质量验证：吊顶特征顶点数检查
  const complexCeilings = (merged.parsed.ceilingFeatures || []).filter(
    cf => cf.polygon && cf.polygon.length > 4
  );
  if (complexCeilings.length > 0) {
    console.log(`  ⚠ 发现 ${complexCeilings.length} 个吊顶特征顶点>4:`);
    complexCeilings.forEach(cf => {
      console.log(`    ${cf.id}: ${cf.polygon.length}点 (期望4点)`);
    });
  }

  return merged;
}

// ============================================================
// 主流程：处理单张照片
// ============================================================

/**
 * 对单张毛坯房照片执行 5-pass 分析
 *
 * @param {string} imagePath  图片路径
 * @param {string} photoId    照片 ID（用于缓存目录命名）
 * @param {string} fileName   原始文件名
 * @param {Object} [opts]
 * @param {string} [opts.cacheDir]   缓存目录，默认 './output/v4/<photoId>'
 * @param {string} [opts.model]      模型名
 * @returns {Promise<Object>} 合并后的分析结果
 */
export async function processPhoto(imagePath, photoId, fileName, opts = {}) {
  const cacheDir = opts.cacheDir || path.resolve('./output/v4', photoId);

  // Pass 1-4: 视觉分析
  const passResults = [];

  for (const cfg of PASS_CONFIGS) {
    const passNum = cfg.name === 'spatial' ? 1 : cfg.name === 'ceiling' ? 2 : cfg.name === 'openings' ? 3 : 4;
    const cacheFile = path.join(cacheDir, `pass${passNum}.json`);

    if (fs.existsSync(cacheFile)) {
      console.log(`  Pass ${passNum} (${cfg.name}): 已有缓存，跳过`);
      passResults.push(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
      continue;
    }

    console.log(`  Pass ${passNum} (${cfg.name}, ${cfg.maxTokens}t)...`);
    try {
      const result = await callVisionAPI({
        imagePath,
        systemPrompt: cfg.systemPrompt,
        userPrompt: cfg.userPrompt,
        maxTokens: cfg.maxTokens,
        model: opts.model,
      });
      const entry = { pass: passNum, name: cfg.name, ...result };
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2));
      passResults.push(entry);
      console.log(`    ${result.error ? '✗ ' + result.error : '✓ OK'} | tokens:${result.usage?.total_tokens || '?'}`);
    } catch (e) {
      console.log(`    ✗ ${e.message}`);
      const entry = { pass: passNum, name: cfg.name, error: e.message, parsed: null, usage: null };
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2));
      passResults.push(entry);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  // Pass 5: 文本合并
  const pass5File = path.join(cacheDir, 'pass5.json');
  if (fs.existsSync(pass5File)) {
    console.log('  Pass 5 (merge): 已有缓存，跳过');
    passResults.push(JSON.parse(fs.readFileSync(pass5File, 'utf-8')));
  } else {
    console.log('  Pass 5 (merge, 2000t)...');
    const p1Json = JSON.stringify(passResults[0]?.parsed || {}, null, 2);
    const p2Json = JSON.stringify(passResults[1]?.parsed || {}, null, 2);
    const p3Json = JSON.stringify(passResults[2]?.parsed || {}, null, 2);
    const p4Json = JSON.stringify(passResults[3]?.parsed || {}, null, 2);
    const mergePrompt = PASS5_USER_TEMPLATE
      .replace('__PASS1__', p1Json)
      .replace('__PASS2__', p2Json)
      .replace('__PASS3__', p3Json)
      .replace('__PASS4__', p4Json);

    try {
      const result = await callVisionAPI({
        systemPrompt: PASS5_SYSTEM,
        userPrompt: mergePrompt,
        maxTokens: 2000,
        model: opts.model,
      });
      const entry = { pass: 5, name: 'merge', ...result };
      fs.writeFileSync(pass5File, JSON.stringify(entry, null, 2));
      passResults.push(entry);
      console.log(`    ${result.error ? '✗ ' + result.error : '✓ OK'} | tokens:${result.usage?.total_tokens || '?'}`);
    } catch (e) {
      console.log(`    ✗ ${e.message}`);
      const entry = { pass: 5, name: 'merge', error: e.message, parsed: null, usage: null };
      fs.writeFileSync(pass5File, JSON.stringify(entry, null, 2));
      passResults.push(entry);
    }
  }

  return mergeResults(photoId, fileName, passResults);
}

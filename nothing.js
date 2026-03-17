/**
 * Патч для LiteGraph: фон канваса рисуется при любом масштабе (в оригинале при scale >= 1.5
 * фон не заливался и рабочее пространство становилось белым при сильном приближении).
 * В продакшене код может быть минифицирован — используем удаление только проверки scale.
 * @param {object} LiteGraph — объект LiteGraph (LG.LiteGraph || LG)
 */
function applyBackgroundZoomPatch(LiteGraph) {
  const LGraphCanvas = LiteGraph.LGraphCanvas;
  if (!LGraphCanvas?.prototype?.drawBackCanvas) return;
  const original = LGraphCanvas.prototype.drawBackCanvas;
  const src = original.toString();

  // Вариант 1: полная замена условия (для неминфицированного кода)
  let fixedSrc = src.replace(
    /this\.ds\.scale\s*<\s*1\.5\s*&&\s*!bg_already_painted\s*&&\s*this\.clear_background_color/,
    "!bg_already_painted && this.clear_background_color"
  );
  let applied = fixedSrc !== src;

  // Вариант 2: удаляем только проверку scale (работает и при минификации)
  if (!applied) {
    fixedSrc = src.replace(/this\.ds\.scale\s*<\s*1\.5\s*&&\s*/g, "");
    applied = fixedSrc !== src;
  }

  if (!applied) return;

  try {
    LGraphCanvas.prototype.drawBackCanvas = new Function(`return ${fixedSrc}`)();
  } catch (_) {}
}

/**
 * Возвращает виджет узла в заданной позиции (координаты графа) или null.
 * @param {object} LiteGraph
 * @param {object} canvas — LGraphCanvas (this)
 * @returns {object|null} виджет или null
 */
function getWidgetAtGraphPos(LiteGraph, canvas) {
  if (!canvas.graph || !canvas.graph_mouse) return null;
  const node = canvas.graph.getNodeOnPos(
    canvas.graph_mouse[0],
    canvas.graph_mouse[1],
    canvas.visible_nodes
  );
  if (!node || !node.widgets || !node.widgets.length) return null;
  const relY = canvas.graph_mouse[1] - node.pos[1];
  const width = node.size[0];
  const H = LiteGraph.NODE_WIDGET_HEIGHT;
  for (let i = 0; i < node.widgets.length; i++) {
    const w = node.widgets[i];
    if (!w || w.last_y === undefined) continue;
    const widgetHeight = w.computeSize ? w.computeSize(width)[1] : H;
    if (relY >= w.last_y && relY < w.last_y + widgetHeight) return w;
  }
  return null;
}

/**
 * Патч для LiteGraph: плейсхолдер (название виджета) в полях string/text
 * отображается только когда значение пустое. Не изменяет саму библиотеку.
 * В модалке редактирования виджета (prompt) заголовок показывается как label/name виджета вместо "Value".
 *
 * Вызывать один раз при инициализации приложения, после импорта litegraph.js.
 * @param {object} LiteGraph — объект LiteGraph (LG.LiteGraph || LG)
 */
/**
 * Патч для LiteGraph: при перетаскивании связи от выхода (connecting_output) выходные слоты
 * других узлов затемняются; при перетаскивании от входа затемняются несовместимые выходы.
 * @param {object} LiteGraph
 *
 * КАК РАБОТАЕТ ПРОВЕРКА СОВМЕСТИМОСТИ В LITEGRAPH
 * -----------------------------------------------
 * Связь всегда идёт ВЫХОД → ВХОД. Семантика: "можно ли соединить?" = isValidConnection(тип_выхода, тип_входа).
 *
 * В библиотеке при отрисовке слотов:
 * 1) Тянем ОТ ВЫХОДА (connecting_output задан): рисуются ВХОДЫ других узлов.
 *    Вызов: isValidConnection(slot.type, out_slot.type) = (тип_входа, тип_выхода) — порядок ОБРАТНЫЙ.
 * 2) Тянем ОТ ВХОДА (connecting_input задан): рисуются ВЫХОДЫ других узлов.
 *    Вызов: isValidConnection(slot_type, in_slot.type) = (тип_выхода, тип_входа) — порядок правильный.
 *
 * Чтобы затемнение не зависело от перепутанного порядка при отрисовке ВХОДОВ,
 * подменяем isValidConnection на симметричную обёртку: проверяем оба порядка (a,b) и (b,a).
 */

/** Коэффициент затемнения слота: 0 = чёрный, 1 = без изменений. */
const DIM_SLOT_FACTOR = 0.58;
/** Коэффициент затемнения подписи. */
const DIM_TEXT_FACTOR = 0.62;

/**
 * Возвращает более тёмную версию цвета (для визуального затемнения слотов).
 * @param {string} color — hex "#RGB" или "#RRGGBB"
 * @param {number} [factor] — доля исходного цвета (остальное — чёрный), по умолчанию DIM_FACTOR
 * @returns {string} hex "#RRGGBB"
 */
function darkenColor(color, factor) {
  if (!color || typeof color !== "string") return "#444";
  factor = factor != null ? factor : DIM_SLOT_FACTOR;
  let hex = color.replace(/^#/, "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6) return "#444";
  const r = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(0, 2), 16) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(2, 4), 16) * factor)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(4, 6), 16) * factor)));
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const DIAMOND_SHAPE = 7;

/** Рисует фигуру слота (beginPath + path) и возвращает doStroke. */
function getEffectiveSlotShape(slot, LiteGraph) {
  if (slot.shape != null) return slot.shape;
  const t = slot.type;
  if (t === "logic") return LiteGraph.BOX_SHAPE;
  if (!t || t === "") return DIAMOND_SHAPE;
  return null;
}

const LOGIC_SLOT_COLOR = "#4A90D9";

function resolveSlotFill(slot, slot_type, isConnected, canvas, fallbackOn, fallbackOff) {
  if (slot_type === "logic" && isConnected) return LOGIC_SLOT_COLOR;
  return isConnected
    ? (slot.color_on || canvas.default_connection_color_byType?.[slot_type] || canvas.default_connection_color?.[fallbackOn])
    : (slot.color_off || canvas.default_connection_color_byTypeOff?.[slot_type] || canvas.default_connection_color_byType?.[slot_type] || canvas.default_connection_color?.[fallbackOff]);
}

function drawSlotShape(ctx, pos, slot_shape, slot_type, horizontal, low_quality, LiteGraph) {
  let doStroke = true;
  ctx.beginPath();
  if (slot_type === LiteGraph.EVENT || slot_shape === LiteGraph.BOX_SHAPE) {
    ctx.rect(pos[0] - 4 + 0.5, pos[1] - 4 + 0.5, 8, 8);
  } else if (slot_shape === LiteGraph.ARROW_SHAPE) {
    ctx.moveTo(pos[0] + 8, pos[1] + 0.5);
    ctx.lineTo(pos[0] - 4, pos[1] + 6 + 0.5);
    ctx.lineTo(pos[0] - 4, pos[1] - 6 + 0.5);
    ctx.closePath();
  } else if (slot_shape === DIAMOND_SHAPE) {
    ctx.moveTo(pos[0], pos[1] - 6);
    ctx.lineTo(pos[0] + 6, pos[1]);
    ctx.lineTo(pos[0], pos[1] + 6);
    ctx.lineTo(pos[0] - 6, pos[1]);
    ctx.closePath();
  } else if (slot_shape === LiteGraph.GRID_SHAPE) {
    ctx.rect(pos[0] - 4, pos[1] - 4, 2, 2);
    ctx.rect(pos[0] - 1, pos[1] - 4, 2, 2);
    ctx.rect(pos[0] + 2, pos[1] - 4, 2, 2);
    ctx.rect(pos[0] - 4, pos[1] - 1, 2, 2);
    ctx.rect(pos[0] - 1, pos[1] - 1, 2, 2);
    ctx.rect(pos[0] + 2, pos[1] - 1, 2, 2);
    ctx.rect(pos[0] - 4, pos[1] + 2, 2, 2);
    ctx.rect(pos[0] - 1, pos[1] + 2, 2, 2);
    ctx.rect(pos[0] + 2, pos[1] + 2, 2, 2);
    doStroke = false;
  } else {
    if (low_quality) ctx.rect(pos[0] - 4, pos[1] - 4, 8, 8);
    else ctx.arc(pos[0], pos[1], 4, 0, Math.PI * 2);
  }
  return doStroke;
}

/**
 * Рисует входные слоты: совместимые с connecting_output — как обычно,
 * несовместимые — слот и подпись рисуются затемнёнными (видимы, но приглушены).
 */
function redrawInputSlotsWithCorrectAlpha(canvas, node, ctx, LiteGraph) {
  const out_slot = canvas.connecting_output;
  if (!out_slot || !node.inputs || !node.inputs.length) return;
  const editor_alpha = canvas.editor_alpha;
  const horizontal = node.horizontal;
  const low_quality = canvas.ds && canvas.ds.scale < 0.6;
  const slot_pos = new Float32Array(2);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "black";
  ctx.shadowColor = "transparent";
  for (let i = 0; i < node.inputs.length; i++) {
    ctx.strokeStyle = "black";
    const slot = node.inputs[i];
    const slot_type = slot.type;
    const compatible = LiteGraph.isValidConnection(out_slot.type, slot_type);
    const pos = node.getConnectionPos(true, i, slot_pos);
    pos[0] -= node.pos[0];
    pos[1] -= node.pos[1];
    let slot_shape = getEffectiveSlotShape(slot, LiteGraph);
    if (slot_type === "array") slot_shape = LiteGraph.GRID_SHAPE;
    const doStroke = drawSlotShape(ctx, pos, slot_shape, slot_type, horizontal, low_quality, LiteGraph);
    const baseFill = resolveSlotFill(slot, slot_type, slot.link != null, canvas, "input_on", "input_off") || "#888";
    const label = slot.label != null ? slot.label : slot.name;
    const textColor = LiteGraph.NODE_TEXT_COLOR || "#333";

    if (compatible) {
      ctx.fillStyle = baseFill;
      ctx.globalAlpha = editor_alpha;
      ctx.fill();
      if (!low_quality && doStroke) ctx.stroke();
      if (label && !low_quality) {
        ctx.fillStyle = textColor;
        ctx.textAlign = horizontal ? "center" : "left";
        if (horizontal || slot.dir === LiteGraph.UP) ctx.fillText(label, pos[0], pos[1] - 10);
        else ctx.fillText(label, pos[0] + 10, pos[1] + 5);
      }
    } else {
      ctx.fillStyle = darkenColor(baseFill);
      ctx.globalAlpha = editor_alpha;
      ctx.fill();
      if (!low_quality && doStroke) {
        ctx.strokeStyle = darkenColor(baseFill, 0.7);
        ctx.stroke();
      }
      if (label && !low_quality) {
        ctx.fillStyle = darkenColor(textColor, DIM_TEXT_FACTOR);
        ctx.textAlign = horizontal ? "center" : "left";
        if (horizontal || slot.dir === LiteGraph.UP) ctx.fillText(label, pos[0], pos[1] - 10);
        else ctx.fillText(label, pos[0] + 10, pos[1] + 5);
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = editor_alpha;
}

/** Все входные слоты на других узлах рисуем затемнёнными (при перетаскивании от входа). */
function redrawInputSlotsDimmed(canvas, node, ctx, LiteGraph) {
  if (!node.inputs || !node.inputs.length) return;
  const editor_alpha = canvas.editor_alpha;
  const horizontal = node.horizontal;
  const low_quality = canvas.ds && canvas.ds.scale < 0.6;
  const slot_pos = new Float32Array(2);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "black";
  ctx.shadowColor = "transparent";
  for (let i = 0; i < node.inputs.length; i++) {
    ctx.strokeStyle = "black";
    const slot = node.inputs[i];
    const slot_type = slot.type;
    const pos = node.getConnectionPos(true, i, slot_pos);
    pos[0] -= node.pos[0];
    pos[1] -= node.pos[1];
    let slot_shape = getEffectiveSlotShape(slot, LiteGraph);
    if (slot_type === "array") slot_shape = LiteGraph.GRID_SHAPE;
    const doStroke = drawSlotShape(ctx, pos, slot_shape, slot_type, horizontal, low_quality, LiteGraph);
    const baseFill = resolveSlotFill(slot, slot_type, slot.link != null, canvas, "input_on", "input_off") || "#888";
    const label = slot.label != null ? slot.label : slot.name;
    const textColor = LiteGraph.NODE_TEXT_COLOR || "#333";
    ctx.fillStyle = darkenColor(baseFill);
    ctx.globalAlpha = editor_alpha;
    ctx.fill();
    if (!low_quality && doStroke) {
      ctx.strokeStyle = darkenColor(baseFill, 0.7);
      ctx.stroke();
    }
    if (label && !low_quality) {
      ctx.fillStyle = darkenColor(textColor, DIM_TEXT_FACTOR);
      ctx.textAlign = horizontal ? "center" : "left";
      if (horizontal || slot.dir === LiteGraph.UP) ctx.fillText(label, pos[0], pos[1] - 10);
      else ctx.fillText(label, pos[0] + 10, pos[1] + 5);
    }
  }
  ctx.restore();
  ctx.globalAlpha = editor_alpha;
}

/** Все выходные слоты на других узлах рисуем затемнёнными (при перетаскивании от выхода). */
function redrawOutputSlotsDimmed(canvas, node, ctx, LiteGraph) {
  if (!node.outputs || !node.outputs.length) return;
  const editor_alpha = canvas.editor_alpha;
  const horizontal = node.horizontal;
  const low_quality = canvas.ds && canvas.ds.scale < 0.6;
  const slot_pos = new Float32Array(2);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "black";
  ctx.shadowColor = "transparent";
  for (let i = 0; i < node.outputs.length; i++) {
    ctx.strokeStyle = "black";
    const slot = node.outputs[i];
    const slot_type = slot.type;
    const pos = node.getConnectionPos(false, i, slot_pos);
    pos[0] -= node.pos[0];
    pos[1] -= node.pos[1];
    let slot_shape = getEffectiveSlotShape(slot, LiteGraph);
    if (slot_type === "array") slot_shape = LiteGraph.GRID_SHAPE;
    const doStroke = drawSlotShape(ctx, pos, slot_shape, slot_type, horizontal, low_quality, LiteGraph);
    const baseFill = resolveSlotFill(slot, slot_type, !!(slot.links && slot.links.length), canvas, "output_on", "output_off") || "#888";
    const label = slot.label != null ? slot.label : slot.name;
    const textColor = LiteGraph.NODE_TEXT_COLOR || "#333";
    ctx.fillStyle = darkenColor(baseFill);
    ctx.globalAlpha = editor_alpha;
    ctx.fill();
    if (label && !low_quality) {
      ctx.fillStyle = darkenColor(textColor, DIM_TEXT_FACTOR);
      ctx.textAlign = horizontal ? "center" : "right";
      if (horizontal) ctx.fillText(label, pos[0], pos[1] - 8);
      else ctx.fillText(label, pos[0] - 10, pos[1] + 5);
    }
  }
  ctx.restore();
  ctx.globalAlpha = editor_alpha;
}

/**
 * При перетаскивании от входа: совместимые выходы рисуем как обычно,
 * несовместимые — слот и подпись рисуются затемнёнными (видимы, но приглушены).
 */
function redrawOutputSlotsWithCorrectAlpha(canvas, node, ctx, LiteGraph) {
  const in_slot = canvas.connecting_input;
  if (!in_slot || !node.outputs || !node.outputs.length) return;
  const editor_alpha = canvas.editor_alpha;

  const horizontal = node.horizontal;
  const low_quality = canvas.ds && canvas.ds.scale < 0.6;
  const slot_pos = new Float32Array(2);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "black";
  ctx.shadowColor = "transparent";
  for (let i = 0; i < node.outputs.length; i++) {
    ctx.strokeStyle = "black";
    const slot = node.outputs[i];
    const slot_type = slot.type;
    const compatible = LiteGraph.isValidConnection(slot_type, in_slot.type);
    const pos = node.getConnectionPos(false, i, slot_pos);
    pos[0] -= node.pos[0];
    pos[1] -= node.pos[1];
    let slot_shape = getEffectiveSlotShape(slot, LiteGraph);
    if (slot_type === "array") slot_shape = LiteGraph.GRID_SHAPE;
    drawSlotShape(ctx, pos, slot_shape, slot_type, horizontal, low_quality, LiteGraph);
    const baseFill = resolveSlotFill(slot, slot_type, !!(slot.links && slot.links.length), canvas, "output_on", "output_off") || "#888";
    const label = slot.label != null ? slot.label : slot.name;
    const textColor = LiteGraph.NODE_TEXT_COLOR || "#333";

    if (compatible) {
      ctx.fillStyle = baseFill;
      ctx.globalAlpha = editor_alpha;
      ctx.fill();
      if (label && !low_quality) {
        ctx.fillStyle = textColor;
        ctx.textAlign = horizontal ? "center" : "right";
        if (horizontal) ctx.fillText(label, pos[0], pos[1] - 8);
        else ctx.fillText(label, pos[0] - 10, pos[1] + 5);
      }
    } else {
      ctx.fillStyle = darkenColor(baseFill);
      ctx.globalAlpha = editor_alpha;
      ctx.fill();
      if (label && !low_quality) {
        ctx.fillStyle = darkenColor(textColor, DIM_TEXT_FACTOR);
        ctx.textAlign = horizontal ? "center" : "right";
        if (horizontal) ctx.fillText(label, pos[0], pos[1] - 8);
        else ctx.fillText(label, pos[0] - 10, pos[1] + 5);
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = editor_alpha;
}

/**
 * Перерисовывает выходные слоты узла в том же стиле, что и входные (залитые круги),
 * чтобы выходы визуально не отличались от входов.
 */
function redrawOutputSlotsLikeInputs(canvas, node, ctx, LiteGraph) {
  if (!node.outputs || !node.outputs.length) return;
  const editor_alpha = canvas.editor_alpha;
  const horizontal = node.horizontal;
  const low_quality = canvas.ds && canvas.ds.scale < 0.6;
  const slot_pos = new Float32Array(2);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "black";
  ctx.shadowColor = "transparent";
  for (let i = 0; i < node.outputs.length; i++) {
    const slot = node.outputs[i];
    const slot_type = slot.type;
    const pos = node.getConnectionPos(false, i, slot_pos);
    pos[0] -= node.pos[0];
    pos[1] -= node.pos[1];
    let slot_shape = getEffectiveSlotShape(slot, LiteGraph);
    if (slot_type === "array") slot_shape = LiteGraph.GRID_SHAPE;
    drawSlotShape(ctx, pos, slot_shape, slot_type, horizontal, low_quality, LiteGraph);
    ctx.fillStyle = resolveSlotFill(slot, slot_type, !!(slot.links && slot.links.length), canvas, "input_on", "input_off") || "#778";
    ctx.globalAlpha = editor_alpha;
    ctx.fill();
    const label = slot.label != null ? slot.label : slot.name;
    if (label && !low_quality) {
      ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR || "#333";
      ctx.textAlign = horizontal ? "center" : "right";
      if (horizontal) ctx.fillText(label, pos[0], pos[1] - 8);
      else ctx.fillText(label, pos[0] - 10, pos[1] + 5);
    }
  }
  ctx.restore();
  ctx.globalAlpha = editor_alpha;
}

/** Рисует входные слоты в обычном состоянии (вне перетаскивания) с правильными формами и цветами. */
function redrawInputSlotsNormal(canvas, node, ctx, LiteGraph) {
  if (!node.inputs || !node.inputs.length) return;
  const editor_alpha = canvas.editor_alpha;
  const horizontal = node.horizontal;
  const low_quality = canvas.ds && canvas.ds.scale < 0.6;
  const slot_pos = new Float32Array(2);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "black";
  ctx.shadowColor = "transparent";
  for (let i = 0; i < node.inputs.length; i++) {
    const slot = node.inputs[i];
    const slot_type = slot.type;
    const pos = node.getConnectionPos(true, i, slot_pos);
    pos[0] -= node.pos[0];
    pos[1] -= node.pos[1];
    let slot_shape = getEffectiveSlotShape(slot, LiteGraph);
    if (slot_type === "array") slot_shape = LiteGraph.GRID_SHAPE;
    drawSlotShape(ctx, pos, slot_shape, slot_type, horizontal, low_quality, LiteGraph);
    ctx.fillStyle = resolveSlotFill(slot, slot_type, slot.link != null, canvas, "input_on", "input_off") || "#778";
    ctx.globalAlpha = editor_alpha;
    ctx.fill();
    const label = slot.label != null ? slot.label : slot.name;
    if (label && !low_quality) {
      ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR || "#333";
      ctx.textAlign = horizontal ? "center" : "left";
      if (horizontal || slot.dir === LiteGraph.UP) ctx.fillText(label, pos[0], pos[1] - 10);
      else ctx.fillText(label, pos[0] + 10, pos[1] + 5);
    }
  }
  ctx.restore();
  ctx.globalAlpha = editor_alpha;
}

function applyOutputSlotDimmingPatch(LiteGraph) {
  const LGraphCanvas = LiteGraph.LGraphCanvas;
  if (!LGraphCanvas?.prototype?.drawNode) return;

  const originalIsValidConnection = LiteGraph.isValidConnection.bind(LiteGraph);
  LiteGraph.isValidConnection = function (type_a, type_b) {
    if (originalIsValidConnection(type_a, type_b)) return true;
    return originalIsValidConnection(type_b, type_a);
  };

  const originalDrawNode = LGraphCanvas.prototype.drawNode;
  LGraphCanvas.prototype.isSlotCompatible = function (outSlot, inSlot) {
    if (!outSlot || !inSlot) return false;
    const outType = outSlot.type ?? 0;
    const inType = inSlot.type ?? 0;
    return LiteGraph.isValidConnection(outType, inType);
  };
  LGraphCanvas.prototype.drawNode = function (node, ctx) {
    let savedOutputs;
    let savedInputs;
    let savedConnectingInput;
    let savedConnectingOutput;
    let needRestoreWidgetsStartY = false;
    let origWidgetsStartY;
    const isConnectingNode = this.connecting_node === node;
    if (isConnectingNode && this.connecting_input) {
      savedConnectingInput = this.connecting_input;
      this.connecting_input = null;
    }
    if (isConnectingNode && this.connecting_output) {
      savedConnectingOutput = this.connecting_output;
      this.connecting_output = null;
    }
    const isDragging = !isConnectingNode && (this.connecting_input || this.connecting_output);
    const hasSlots = (node.inputs?.length || node.outputs?.length) && !node.flags?.collapsed;
    if (hasSlots) {
      savedOutputs = node.outputs;
      savedInputs = node.inputs;
      if (node.widgets?.length && !node.widgets_up && !node.horizontal) {
        needRestoreWidgetsStartY = true;
        origWidgetsStartY = node.widgets_start_y;
        if (node.widgets_start_y == null) {
          const slotPos = new Float32Array(2);
          const halfH = (LiteGraph.NODE_SLOT_HEIGHT || 20) * 0.5;
          let maxY = 0;
          for (let i = 0; i < (savedInputs?.length || 0); i++) {
            const pos = node.getConnectionPos(true, i, slotPos);
            maxY = Math.max(maxY, pos[1] - node.pos[1] + halfH);
          }
          for (let i = 0; i < (savedOutputs?.length || 0); i++) {
            const pos = node.getConnectionPos(false, i, slotPos);
            maxY = Math.max(maxY, pos[1] - node.pos[1] + halfH);
          }
          node.widgets_start_y = maxY;
        }
      }
      node.outputs = [];
      node.inputs = [];
    }
    try {
      const result = originalDrawNode.call(this, node, ctx);
      if (savedOutputs != null || savedInputs != null) {
        node.outputs = savedOutputs || node.outputs;
        node.inputs = savedInputs || node.inputs;
        if (isDragging && this.connecting_input) {
          if (savedOutputs?.length) redrawOutputSlotsWithCorrectAlpha(this, node, ctx, LiteGraph);
          if (savedInputs?.length) redrawInputSlotsDimmed(this, node, ctx, LiteGraph);
        } else if (isDragging && this.connecting_output) {
          if (savedInputs?.length) redrawInputSlotsWithCorrectAlpha(this, node, ctx, LiteGraph);
          if (savedOutputs?.length) redrawOutputSlotsDimmed(this, node, ctx, LiteGraph);
        } else {
          if (savedInputs?.length) redrawInputSlotsNormal(this, node, ctx, LiteGraph);
          if (savedOutputs?.length) redrawOutputSlotsLikeInputs(this, node, ctx, LiteGraph);
        }
      }
      return result;
    } finally {
      if (savedOutputs) node.outputs = savedOutputs;
      if (savedInputs) node.inputs = savedInputs;
      if (needRestoreWidgetsStartY) {
        if (origWidgetsStartY == null) delete node.widgets_start_y;
        else node.widgets_start_y = origWidgetsStartY;
      }
      if (savedConnectingInput !== undefined) this.connecting_input = savedConnectingInput;
      if (savedConnectingOutput !== undefined) this.connecting_output = savedConnectingOutput;
      ctx.globalAlpha = this.editor_alpha;
    }
  };

  const origIsOverNodeInput = LGraphCanvas.prototype.isOverNodeInput;
  if (origIsOverNodeInput) {
    LGraphCanvas.prototype.isOverNodeInput = function (node, canvasx, canvasy, slot_pos) {
      // Сначала даём шанс оригинальной реализации (точное попадание по слоту)
      let result = origIsOverNodeInput.call(
        this,
        node,
        canvasx,
        canvasy,
        slot_pos
      );
      if (result !== -1) {
        return result;
      }

      // Если связь тянется ОТ ВЫХОДА и курсор над нодой, но не над конкретным слотом,
      // автоматически выбираем ПОСЛЕДНИЙ свободный совместимый входной слот.
      // Если свободных нет — последний совместимый.
      const outSlot = this.connecting_output;
      if (!outSlot || !node || !node.inputs || !node.inputs.length) {
        return -1;
      }

      const outType = outSlot.type ?? 0;
      let lastFreeMatch = -1;
      let lastAnyMatch = -1;

      for (let i = 0; i < node.inputs.length; i++) {
        const slot = node.inputs[i];
        if (!slot) continue;
        const inType = slot.type ?? 0;
        if (!LiteGraph.isValidConnection(outType, inType)) continue;
        lastAnyMatch = i;
        if (slot.link == null) {
          lastFreeMatch = i;
        }
      }

      const chosen =
        lastFreeMatch !== -1
          ? lastFreeMatch
          : lastAnyMatch !== -1
            ? lastAnyMatch
            : -1;

      if (chosen === -1) {
        return -1;
      }

      if (slot_pos) {
        const temp = new Float32Array(2);
        node.getConnectionPos(true, chosen, temp);
        slot_pos[0] = temp[0];
        slot_pos[1] = temp[1];
      }

      if (
        slot_pos &&
        typeof slot_pos[0] === "number" &&
        typeof slot_pos[1] === "number"
      ) {
        this._highlight_input = [slot_pos[0], slot_pos[1]];
      }
      this._highlight_input_slot = node.inputs[chosen];

      return chosen;
    };
  }

  const origIsOverNodeOutput = LGraphCanvas.prototype.isOverNodeOutput;
  if (origIsOverNodeOutput) {
    LGraphCanvas.prototype.isOverNodeOutput = function (
      node,
      canvasx,
      canvasy,
      slot_pos
    ) {
      // Сначала стандартное поведение (точное попадание по слоту)
      let result = origIsOverNodeOutput.call(
        this,
        node,
        canvasx,
        canvasy,
        slot_pos
      );
      if (result !== -1) {
        if (node.outputs?.[result]) {
          this._highlight_output_slot = node.outputs[result];
        }
        return result;
      }

      // Если тянем ОТ ВХОДА и отпускаем на ноде — выбираем последний свободный
      // совместимый выход, если таких нет — последний совместимый.
      const inSlot = this.connecting_input;
      if (!inSlot || !node || !node.outputs || !node.outputs.length) {
        return -1;
      }

      const inType = inSlot.type ?? 0;
      let lastFreeMatch = -1;
      let lastAnyMatch = -1;

      for (let i = 0; i < node.outputs.length; i++) {
        const slot = node.outputs[i];
        if (!slot) continue;
        const outType = slot.type ?? 0;
        if (!LiteGraph.isValidConnection(outType, inType)) continue;
        lastAnyMatch = i;
        const links = slot.links;
        const isFree = !links || !links.length;
        if (isFree) {
          lastFreeMatch = i;
        }
      }

      const chosen =
        lastFreeMatch !== -1
          ? lastFreeMatch
          : lastAnyMatch !== -1
            ? lastAnyMatch
            : -1;

      if (chosen === -1) {
        return -1;
      }

      if (slot_pos) {
        const temp = new Float32Array(2);
        node.getConnectionPos(false, chosen, temp);
        slot_pos[0] = temp[0];
        slot_pos[1] = temp[1];
      }

      if (
        slot_pos &&
        typeof slot_pos[0] === "number" &&
        typeof slot_pos[1] === "number"
      ) {
        this._highlight_output = [slot_pos[0], slot_pos[1]];
      }
      this._highlight_output_slot = node.outputs[chosen];

      return chosen;
    };
  }

  function drawConnectingShape(ctx, pos, slot, LG) {
    const shape = slot ? (getEffectiveSlotShape(slot, LG) ?? slot.shape) : null;
    ctx.beginPath();
    if (slot && (slot.type === LG.EVENT || shape === LG.BOX_SHAPE)) {
      ctx.rect(pos[0] - 4 + 0.5, pos[1] - 4 + 0.5, 8, 8);
    } else if (shape === LG.ARROW_SHAPE) {
      ctx.moveTo(pos[0] + 8, pos[1] + 0.5);
      ctx.lineTo(pos[0] - 4, pos[1] + 6 + 0.5);
      ctx.lineTo(pos[0] - 4, pos[1] - 6 + 0.5);
      ctx.closePath();
    } else if (shape === DIAMOND_SHAPE) {
      ctx.moveTo(pos[0], pos[1] - 6);
      ctx.lineTo(pos[0] + 6, pos[1]);
      ctx.lineTo(pos[0], pos[1] + 6);
      ctx.lineTo(pos[0] - 6, pos[1]);
      ctx.closePath();
    } else {
      ctx.arc(pos[0], pos[1], 4, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  function drawHighlightShape(ctx, pos, slot, LG) {
    const shape = slot ? (getEffectiveSlotShape(slot, LG) ?? slot.shape) : null;
    ctx.beginPath();
    if (slot && (slot.type === LG.EVENT || shape === LG.BOX_SHAPE)) {
      ctx.rect(pos[0] - 5 + 0.5, pos[1] - 5 + 0.5, 10, 10);
    } else if (shape === LG.ARROW_SHAPE) {
      ctx.moveTo(pos[0] + 8, pos[1] + 0.5);
      ctx.lineTo(pos[0] - 4, pos[1] + 6 + 0.5);
      ctx.lineTo(pos[0] - 4, pos[1] - 6 + 0.5);
      ctx.closePath();
    } else if (shape === DIAMOND_SHAPE) {
      ctx.moveTo(pos[0], pos[1] - 8);
      ctx.lineTo(pos[0] + 8, pos[1]);
      ctx.lineTo(pos[0], pos[1] + 8);
      ctx.lineTo(pos[0] - 8, pos[1]);
      ctx.closePath();
    } else {
      ctx.arc(pos[0], pos[1], 6, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  const origDrawFrontCanvas = LGraphCanvas.prototype.drawFrontCanvas;
  if (origDrawFrontCanvas) {
    LGraphCanvas.prototype.drawFrontCanvas = function () {
      const savedPos = this.connecting_pos;
      const savedHI = this._highlight_input;
      const savedHIS = this._highlight_input_slot;
      const savedHO = this._highlight_output;
      const savedHOS = this._highlight_output_slot;
      if (savedPos != null) {
        this.connecting_pos = null;
        this._highlight_input = null;
        this._highlight_output = null;
      }
      origDrawFrontCanvas.call(this);
      this.connecting_pos = savedPos;
      this._highlight_input = savedHI;
      this._highlight_input_slot = savedHIS;
      this._highlight_output = savedHO;
      this._highlight_output_slot = savedHOS;
      if (savedPos == null || !this.graph) return;

      var ctx = this.ctx;
      if (!ctx) return;
      ctx.save();
      this.ds.toCanvasContext(ctx);

      var connInOrOut = this.connecting_output || this.connecting_input;
      if (!connInOrOut) { ctx.restore(); return; }
      var connType = connInOrOut.type;
      var connDir = connInOrOut.dir;
      if (connDir == null) {
        connDir = this.connecting_output
          ? (this.connecting_node?.horizontal ? LiteGraph.DOWN : LiteGraph.RIGHT)
          : (this.connecting_node?.horizontal ? LiteGraph.UP : LiteGraph.LEFT);
      }

      var link_color;
      if (connType === LiteGraph.EVENT) {
        link_color = LiteGraph.EVENT_LINK_COLOR;
      } else {
        link_color = (this.link_type_colors && this.link_type_colors[connType])
          || (LGraphCanvas.link_type_colors && LGraphCanvas.link_type_colors[connType])
          || LiteGraph.CONNECTING_LINK_COLOR;
      }

      ctx.lineWidth = this.connections_width;
      this.renderLink(ctx, savedPos, [this.graph_mouse[0], this.graph_mouse[1]], null, false, null, link_color, connDir, LiteGraph.CENTER);

      ctx.fillStyle = link_color;
      drawConnectingShape(ctx, savedPos, connInOrOut, LiteGraph);
      drawConnectingShape(ctx, [this.graph_mouse[0], this.graph_mouse[1]], connInOrOut, LiteGraph);

      ctx.fillStyle = "#ffcc00";
      if (this._highlight_input) {
        drawHighlightShape(ctx, this._highlight_input, this._highlight_input_slot, LiteGraph);
      }
      if (this._highlight_output) {
        drawHighlightShape(ctx, this._highlight_output, this._highlight_output_slot || null, LiteGraph);
      }

      ctx.restore();
    };
  }
}

/**
 * Патч LGraphNode.prototype.connect: guard against undefined inputs[target_slot].
 * onBeforeConnectInput can change target_slot, and disconnectInput triggered inside
 * connect() can shrink the inputs array via onConnectionsChange (e.g. ForNode).
 * Without this guard, assigning `.link` on undefined crashes the editor.
 */
function applyConnectSafePatch(LiteGraph) {
  const LGraphNode = LiteGraph.LGraphNode;
  if (!LGraphNode?.prototype?.connect) return;
  const origConnect = LGraphNode.prototype.connect;

  LGraphNode.prototype.connect = function (slot, target_node, target_slot) {
    if (
      target_node &&
      target_slot != null &&
      (!target_node.inputs || !target_node.inputs[target_slot])
    ) {
      return null;
    }
    try {
      return origConnect.apply(this, arguments);
    } catch (e) {
      if (
        e instanceof TypeError &&
        e.message &&
        e.message.indexOf("setting 'link'") !== -1
      ) {
        return null;
      }
      throw e;
    }
  };
}

export function applyWidgetPlaceholderPatch(LiteGraph) {
  applyBackgroundZoomPatch(LiteGraph);
  applyConnectSafePatch(LiteGraph);
  applyOutputSlotDimmingPatch(LiteGraph);

  // Увеличиваем лимит нод в графе (иначе выбрасывается "LiteGraph: max number of nodes in a graph reached").
  // Делаем это через патч (без правок node_modules), чтобы применялось для всех графов.
  if (LiteGraph && typeof LiteGraph.MAX_NUMBER_OF_NODES === "number") {
    LiteGraph.MAX_NUMBER_OF_NODES = 15000;
  }

  // Автоматическая установка формы и цвета порта по типу слота:
  // logic → квадрат + синий при подключении, model → круг, any ("") → ромб
  const LGraphNode = LiteGraph.LGraphNode;
  if (LGraphNode?.prototype) {
    const origAddInput = LGraphNode.prototype.addInput;
    LGraphNode.prototype.addInput = function (name, type, extra_info) {
      const result = origAddInput.call(this, name, type, extra_info);
      const slot = this.inputs && this.inputs[this.inputs.length - 1];
      if (slot) {
        if (type === "logic") {
          if (slot.shape == null) slot.shape = LiteGraph.BOX_SHAPE;
          slot.color_on = LOGIC_SLOT_COLOR;
        } else if (!type || type === "") {
          if (slot.shape == null) slot.shape = DIAMOND_SHAPE;
        }
      }
      return result;
    };
    const origAddOutput = LGraphNode.prototype.addOutput;
    LGraphNode.prototype.addOutput = function (name, type, extra_info) {
      const result = origAddOutput.call(this, name, type, extra_info);
      const slot = this.outputs && this.outputs[this.outputs.length - 1];
      if (slot) {
        if (type === "logic") {
          if (slot.shape == null) slot.shape = LiteGraph.BOX_SHAPE;
          slot.color_on = LOGIC_SLOT_COLOR;
        } else if (!type || type === "") {
          if (slot.shape == null) slot.shape = DIAMOND_SHAPE;
        }
      }
      return result;
    };
  }

  const LGraphCanvas = LiteGraph.LGraphCanvas;
  if (!LGraphCanvas?.prototype?.drawNodeWidgets) return;

  // Заголовок модалки редактирования — плейсхолдер виджета (label/name) вместо "Value"
  // и привязка окна к полю графа при панорамировании/зуме
  const originalPrompt = LGraphCanvas.prototype.prompt;
  if (originalPrompt) {
    LGraphCanvas.prototype.prompt = function (title, value, callback, event, multiline) {
      if (title === "Value") {
        const w = getWidgetAtGraphPos(LiteGraph, this);
        if (w) title = (w.label != null && w.label !== "") ? w.label : (w.name || "Value");
      }

      const canvas = this;
      let anchorGraph = null;
      if (event && canvas.canvas) {
        const rect = canvas.canvas.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const bufX = rect.width && canvas.canvas.width ? cx * (canvas.canvas.width / rect.width) : cx;
        const bufY = rect.height && canvas.canvas.height ? cy * (canvas.canvas.height / rect.height) : cy;
        anchorGraph = canvas.convertCanvasToOffset([bufX, bufY]);
      }

      const dialog = originalPrompt.call(this, title, value, callback, event, multiline);

      if (dialog && anchorGraph && canvas.canvas) {
        const node = canvas.graph && canvas.graph_mouse
          ? canvas.graph.getNodeOnPos(
              canvas.graph_mouse[0],
              canvas.graph_mouse[1],
              canvas.visible_nodes
            )
          : null;
        const offsetFromNode =
          node && anchorGraph
            ? [
                anchorGraph[0] - node.pos[0],
                anchorGraph[1] - node.pos[1],
              ]
            : null;

        const offsetx = -20;
        const offsety = -20;
        let rafId = 0;

        const updatePosition = () => {
          if (!canvas.prompt_box || !canvas.prompt_box.parentNode) {
            if (rafId) cancelAnimationFrame(rafId);
            return;
          }
          const container = canvas.canvas.parentNode;
          if (!container) {
            rafId = requestAnimationFrame(updatePosition);
            return;
          }
          // Якорь: если есть нода и смещение — окно следует за нодой при перетаскивании
          const effectiveAnchor =
            offsetFromNode &&
            node &&
            node.graph === canvas.graph
              ? [
                  node.pos[0] + offsetFromNode[0],
                  node.pos[1] + offsetFromNode[1],
                ]
              : anchorGraph;
          // Координаты графа → буфер канваса (с учётом зума графа)
          const canvasPos = canvas.convertOffsetToCanvas(effectiveAnchor);
          // Буфер канваса может отличаться от отображаемого размера (devicePixelRatio, масштаб страницы)
          const canvasRect = canvas.canvas.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const scaleX = canvasRect.width / canvas.canvas.width;
          const scaleY = canvasRect.height / canvas.canvas.height;
          // Визуальный масштаб графа в CSS: граф рисуется в буфере с ds.scale, буфер показывается с scaleX
          const displayScale = Math.abs(scaleX - scaleY) < 1e-6 ? scaleX : (scaleX + scaleY) * 0.5;

          // Масштаб модалки = масштаб графа в экранных пикселях, чтобы пропорционально нодам
          const graphScale = canvas.ds && typeof canvas.ds.scale === "number"
            ? canvas.ds.scale * displayScale
            : displayScale;
          canvas.prompt_box.style.transformOrigin = "top left";
          canvas.prompt_box.style.transform = `scale(${graphScale})`;

          const leftInContainer =
            (canvasRect.left - containerRect.left) + canvasPos[0] * scaleX + offsetx;
          const topInContainer =
            (canvasRect.top - containerRect.top) + canvasPos[1] * scaleY + offsety;
          canvas.prompt_box.style.left = leftInContainer + "px";
          canvas.prompt_box.style.top = topInContainer + "px";
          rafId = requestAnimationFrame(updatePosition);
        };
        rafId = requestAnimationFrame(updatePosition);

        const originalClose = dialog.close;
        dialog.close = function () {
          if (rafId) cancelAnimationFrame(rafId);
          originalClose.call(this);
        };
      }

      return dialog;
    };
  }

  LGraphCanvas.prototype.drawNodeWidgets = function (node, posY, ctx, active_widget) {
    if (!node.widgets || !node.widgets.length) {
      return 0;
    }
    const width = node.size[0];
    const widgets = node.widgets;
    posY += 2;
    const H = LiteGraph.NODE_WIDGET_HEIGHT;
    const show_text = this.ds.scale > 0.5;
    ctx.save();
    ctx.globalAlpha = this.editor_alpha;
    const outline_color = LiteGraph.WIDGET_OUTLINE_COLOR;
    const background_color = LiteGraph.WIDGET_BGCOLOR;
    const text_color = LiteGraph.WIDGET_TEXT_COLOR;
    const secondary_text_color = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
    const margin = 15;

    for (let i = 0; i < widgets.length; ++i) {
      const w = widgets[i];
      let y = posY;
      if (w.y) {
        y = w.y;
      }
      w.last_y = y;
      ctx.strokeStyle = outline_color;
      ctx.fillStyle = "#222";
      ctx.textAlign = "left";
      if (w.disabled) ctx.globalAlpha *= 0.5;
      const widget_width = w.width || width;

      switch (w.type) {
        case "button":
          if (w.clicked) {
            ctx.fillStyle = "#AAA";
            w.clicked = false;
            this.dirty_canvas = true;
          }
          ctx.fillRect(margin, y, widget_width - margin * 2, H);
          if (show_text && !w.disabled)
            ctx.strokeRect(margin, y, widget_width - margin * 2, H);
          if (show_text) {
            ctx.textAlign = "center";
            ctx.fillStyle = text_color;
            ctx.fillText(w.label || w.name, widget_width * 0.5, y + H * 0.7);
          }
          break;
        case "toggle":
          ctx.textAlign = "left";
          ctx.strokeStyle = outline_color;
          ctx.fillStyle = background_color;
          ctx.beginPath();
          if (show_text) ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5]);
          else ctx.rect(margin, y, widget_width - margin * 2, H);
          ctx.fill();
          if (show_text && !w.disabled) ctx.stroke();
          ctx.fillStyle = w.value ? "#89A" : "#333";
          ctx.beginPath();
          ctx.arc(widget_width - margin * 2, y + H * 0.5, H * 0.36, 0, Math.PI * 2);
          ctx.fill();
          if (show_text) {
            ctx.fillStyle = secondary_text_color;
            const toggleLabel = w.label || w.name;
            if (toggleLabel != null) {
              ctx.fillText(toggleLabel, margin * 2, y + H * 0.7);
            }
            ctx.fillStyle = w.value ? text_color : secondary_text_color;
            ctx.textAlign = "right";
            ctx.fillText(
              w.value ? w.options.on || "Да" : w.options.off || "Нет",
              widget_width - 40,
              y + H * 0.7
            );
          }
          break;
        case "slider":
          ctx.fillStyle = background_color;
          ctx.fillRect(margin, y, widget_width - margin * 2, H);
          let range = w.options.max - w.options.min;
          let nvalue = (w.value - w.options.min) / range;
          if (nvalue < 0.0) nvalue = 0.0;
          if (nvalue > 1.0) nvalue = 1.0;
          ctx.fillStyle = w.options.hasOwnProperty("slider_color")
            ? w.options.slider_color
            : active_widget === w ? "#89A" : "#678";
          ctx.fillRect(margin, y, nvalue * (widget_width - margin * 2), H);
          if (show_text && !w.disabled) ctx.strokeRect(margin, y, widget_width - margin * 2, H);
          if (w.marker) {
            let marker_nvalue = (w.marker - w.options.min) / range;
            if (marker_nvalue < 0.0) marker_nvalue = 0.0;
            if (marker_nvalue > 1.0) marker_nvalue = 1.0;
            ctx.fillStyle = w.options.hasOwnProperty("marker_color")
              ? w.options.marker_color
              : "#AA9";
            ctx.fillRect(
              margin + marker_nvalue * (widget_width - margin * 2),
              y,
              2,
              H
            );
          }
          if (show_text) {
            ctx.textAlign = "center";
            ctx.fillStyle = text_color;
            ctx.fillText(
              (w.label || w.name) +
                "  " +
                Number(w.value).toFixed(
                  w.options.precision != null ? w.options.precision : 3
                ),
              widget_width * 0.5,
              y + H * 0.7
            );
          }
          break;
        case "number":
        case "combo":
          ctx.textAlign = "left";
          ctx.strokeStyle = outline_color;
          ctx.fillStyle = background_color;
          ctx.beginPath();
          if (show_text)
            ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5]);
          else ctx.rect(margin, y, widget_width - margin * 2, H);
          ctx.fill();
          if (show_text) {
            if (!w.disabled) ctx.stroke();
            ctx.fillStyle = text_color;
            if (!w.disabled) {
              if (w.options && typeof w.options.getLabel === "function") {
                // Dropdown-style: single down arrow on the right
                const arrowX = widget_width - margin - 14;
                const arrowY = y + H * 0.5;
                ctx.beginPath();
                ctx.moveTo(arrowX - 5, arrowY - 3);
                ctx.lineTo(arrowX + 5, arrowY - 3);
                ctx.lineTo(arrowX, arrowY + 4);
                ctx.closePath();
                ctx.fill();
              } else {
                ctx.beginPath();
                ctx.moveTo(margin + 16, y + 5);
                ctx.lineTo(margin + 6, y + H * 0.5);
                ctx.lineTo(margin + 16, y + H - 5);
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(widget_width - margin - 16, y + 5);
                ctx.lineTo(widget_width - margin - 6, y + H * 0.5);
                ctx.lineTo(widget_width - margin - 16, y + H - 5);
                ctx.fill();
              }
            }
            ctx.fillStyle = secondary_text_color;
            ctx.fillText(w.label || w.name, margin * 2 + 5, y + H * 0.7);
            ctx.fillStyle = text_color;
            ctx.textAlign = "right";
            if (w.type === "number") {
              ctx.fillText(
                Number(w.value).toFixed(
                  w.options.precision !== undefined ? w.options.precision : 3
                ),
                widget_width - margin * 2 - 20,
                y + H * 0.7
              );
            } else {
              let v = w.value;
              if (w.options.values) {
                let values = w.options.values;
                if (values.constructor === Function) values = values();
                if (values && values.constructor !== Array) v = values[w.value];
              }
              if (w.options.getLabel && typeof w.options.getLabel === "function") {
                v = w.options.getLabel(w.value);
              }
              let displayVal =
                v === true || String(v).toLowerCase() === "true"
                  ? "Да"
                  : v === false || String(v).toLowerCase() === "false"
                    ? "Нет"
                    : v;
              if (typeof displayVal === "string" && displayVal.length > 20) {
                displayVal = displayVal.slice(0, 35) + "…";
              }
              ctx.fillText(displayVal, widget_width - margin * 2 - 20, y + H * 0.7);
            }
          }
          break;
        case "string":
        case "text":
          ctx.textAlign = "left";
          ctx.strokeStyle = outline_color;
          ctx.fillStyle = background_color;
          ctx.beginPath();
          if (show_text)
            ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5]);
          else ctx.rect(margin, y, widget_width - margin * 2, H);
          ctx.fill();
          if (show_text) {
            if (!w.disabled) ctx.stroke();
            ctx.save();
            ctx.beginPath();
            ctx.rect(margin, y, widget_width - margin * 2, H);
            ctx.clip();
            const label = w.label || w.name;
            const hasValue =
              w.value !== undefined &&
              w.value !== null &&
              String(w.value).trim() !== "";
            if (label != null && !hasValue) {
              ctx.fillStyle = secondary_text_color;
              ctx.fillText(label, margin * 2, y + H * 0.7);
            }
            ctx.fillStyle = text_color;
            ctx.textAlign = "right";
            ctx.fillText(
              String(w.value || "").substr(0, 30),
              widget_width - margin * 2,
              y + H * 0.7
            );
            ctx.restore();
          }
          break;
        default:
          if (w.draw) {
            w.draw(ctx, node, widget_width, y, H);
          }
          break;
      }
      posY += (w.computeSize ? w.computeSize(widget_width)[1] : H) + 4;
      ctx.globalAlpha = this.editor_alpha;
    }
    ctx.restore();
    ctx.textAlign = "left";
  };

  // Комбо «Шаблон» в узле подграфа: по клику по центру показывать меню с названиями (getLabel), а не с id
  const originalProcessNodeWidgets = LGraphCanvas.prototype.processNodeWidgets;
  if (originalProcessNodeWidgets) {
    const pointerDown = (LiteGraph.pointerevents_method || "mouse") + "down";
    LGraphCanvas.prototype.processNodeWidgets = function (node, pos, event, active_widget) {
      if (
        node.widgets &&
        node.widgets.length &&
        event.type === pointerDown &&
        (this.allow_interaction || (node.flags && node.flags.allow_interaction))
      ) {
        const x = pos[0] - node.pos[0];
        const y = pos[1] - node.pos[1];
        const width = node.size[0];
        for (let i = 0; i < node.widgets.length; i++) {
          const w = node.widgets[i];
          if (!w || w.disabled || w.type !== "combo") continue;
          const widgetHeight = w.computeSize ? w.computeSize(width)[1] : LiteGraph.NODE_WIDGET_HEIGHT;
          const widget_width = w.width || width;
          if (w.last_y === undefined || y < w.last_y || y >= w.last_y + widgetHeight) continue;
          if (!w.options || typeof w.options.getLabel !== "function") continue;
          let values = w.options.values;
          if (typeof values === "function") values = values(w, node);
          if (!values || !Array.isArray(values)) break;
          const getLabel = w.options.getLabel;
          const labels = values.map((v) => (getLabel ? getLabel(v) : String(v)));
          const that = this;
          const ref_window = typeof this.getCanvasWindow === "function" ? this.getCanvasWindow() : window;
          const menu = new LiteGraph.ContextMenu(labels, {
            scale: Math.max(1, (this.ds && this.ds.scale) || 1),
            event: event,
            className: "dark graph-editor-widget-context-menu",
            callback: function (selectedLabel) {
              const idx = labels.indexOf(selectedLabel);
              if (idx < 0) return false;
              const value = values[idx];
              const old = w.value;
              w.value = value;
              if (w.options && w.options.property && node.properties[w.options.property] !== undefined) {
                node.setProperty(w.options.property, value);
              }
              if (w.callback) w.callback(value, that, node, pos, event);
              if (node.onWidgetChanged) node.onWidgetChanged(w.name, value, old, w);
              if (node.graph) node.graph._version++;
              that.dirty_canvas = true;
              return false;
            },
          }, ref_window);

          // Растягиваем меню по ширине самого длинного пункта:
          // снимаем overflow/maxHeight, замеряем естественную ширину, фиксируем.
          try {
            const menuRoot = menu && menu.root;
            if (menuRoot) {
              const entries = menuRoot.querySelectorAll(".litemenu-entry");
              entries.forEach(function (el) {
                el.style.whiteSpace = "nowrap";
              });
              menuRoot.style.overflow = "visible";
              menuRoot.style.width = "auto";
              menuRoot.style.maxHeight = "none";
              void menuRoot.offsetWidth;
              const naturalWidth = menuRoot.scrollWidth;
              menuRoot.style.overflow = "";
              menuRoot.style.maxHeight = "";
              if (naturalWidth > 0) {
                menuRoot.style.width = naturalWidth + "px";
              }
            }
          } catch (_) { /* ignore */ }

          // Пока курсор над выпадающим списком, прокручиваем только его, а не страницу/канвас.
          // LiteGraph ContextMenu по умолчанию двигает весь элемент меню (style.top)
          // через capture-phase wheel/mousewheel обработчик.  Наш обработчик
          // срабатывает после него (bubble), поэтому мы сбрасываем top обратно
          // и вместо этого прокручиваем содержимое внутри ограниченного контейнера.
          try {
            const menuRoot = menu && menu.root;
            if (menuRoot && menuRoot.addEventListener) {
              const fixedTop = menuRoot.style.top;

              const onWheel = function (e) {
                const delta = e.deltaY || e.wheelDelta || 0;
                if (!delta) return;

                e.preventDefault();
                e.stopPropagation();

                // LiteGraph capture-phase handler уже сдвинул style.top — откатываем
                menuRoot.style.top = fixedTop;

                const nextScrollTop = menuRoot.scrollTop + delta;
                const maxScrollTop = menuRoot.scrollHeight - menuRoot.clientHeight;

                if (nextScrollTop < 0) {
                  menuRoot.scrollTop = 0;
                } else if (nextScrollTop > maxScrollTop) {
                  menuRoot.scrollTop = maxScrollTop;
                } else {
                  menuRoot.scrollTop = nextScrollTop;
                }
              };

              menuRoot.addEventListener("wheel", onWheel, { passive: false });
              menuRoot.addEventListener("mousewheel", onWheel, { passive: false });
            }
          } catch (e) {
            if (typeof console !== "undefined" && console.warn) {
              console.warn("graph-editor widget menu wheel handler error", e);
            }
          }

          return w;
        }
      }
      return originalProcessNodeWidgets.apply(this, arguments);
    };
  }
}

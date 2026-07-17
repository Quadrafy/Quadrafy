(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) =>
      element.setAttribute(key, String(value)),
    );
    return element;
  }

  function chartShell(container, label, width, height) {
    container.replaceChildren();
    const svg = svgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": label,
      preserveAspectRatio: "xMidYMid meet",
    });
    const title = svgElement("title");
    title.textContent = label;
    svg.append(title);
    container.append(svg);
    return svg;
  }

  function renderLine(container, items, { label, formatValue }) {
    const width = 720;
    const height = 250;
    const padding = { top: 20, right: 18, bottom: 42, left: 58 };
    const svg = chartShell(container, label, width, height);
    const values = items.map((item) => Number(item.value || 0));
    const maximum = Math.max(1, ...values);
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    for (let index = 0; index <= 4; index += 1) {
      const y = padding.top + (plotHeight / 4) * index;
      const line = svgElement("line", {
        x1: padding.left,
        x2: width - padding.right,
        y1: y,
        y2: y,
        class: "chart-grid-line",
      });
      const text = svgElement("text", {
        x: padding.left - 9,
        y: y + 4,
        class: "chart-axis-label",
        "text-anchor": "end",
      });
      text.textContent = formatValue(maximum * (1 - index / 4));
      svg.append(line, text);
    }

    const points = items.map((item, index) => {
      const x =
        padding.left +
        (items.length === 1 ? plotWidth / 2 : (plotWidth * index) / (items.length - 1));
      const y = padding.top + plotHeight * (1 - Number(item.value || 0) / maximum);
      return { x, y, item };
    });
    if (points.length) {
      const path = svgElement("polyline", {
        points: points.map(({ x, y }) => `${x},${y}`).join(" "),
        class: "chart-line",
      });
      svg.append(path);
    }
    const labelStep = Math.max(1, Math.ceil(items.length / 7));
    points.forEach(({ x, y, item }, index) => {
      const point = svgElement("circle", {
        cx: x,
        cy: y,
        r: 4,
        class: "chart-point",
      });
      const pointTitle = svgElement("title");
      pointTitle.textContent = `${item.label}: ${formatValue(item.value)}`;
      point.append(pointTitle);
      svg.append(point);
      if (index % labelStep === 0 || index === items.length - 1) {
        const text = svgElement("text", {
          x,
          y: height - 15,
          class: "chart-axis-label",
          "text-anchor": "middle",
        });
        text.textContent = item.shortLabel || item.label;
        svg.append(text);
      }
    });
  }

  function renderBars(container, items, { label, formatValue }) {
    const width = 620;
    const rowHeight = 48;
    const height = Math.max(170, 34 + items.length * rowHeight);
    const labelWidth = 145;
    const valueWidth = 95;
    const svg = chartShell(container, label, width, height);
    const maximum = Math.max(1, ...items.map((item) => Number(item.value || 0)));
    const barWidth = width - labelWidth - valueWidth - 30;
    items.forEach((item, index) => {
      const y = 22 + index * rowHeight;
      const name = svgElement("text", {
        x: labelWidth - 10,
        y: y + 18,
        class: "chart-bar-label",
        "text-anchor": "end",
      });
      name.textContent = item.label;
      const track = svgElement("rect", {
        x: labelWidth,
        y,
        width: barWidth,
        height: 24,
        rx: 5,
        class: "chart-bar-track",
      });
      const bar = svgElement("rect", {
        x: labelWidth,
        y,
        width: Math.max(0, (barWidth * Number(item.value || 0)) / maximum),
        height: 24,
        rx: 5,
        class: `chart-bar chart-series-${(index % 3) + 1}`,
      });
      const value = svgElement("text", {
        x: labelWidth + barWidth + 10,
        y: y + 18,
        class: "chart-bar-value",
      });
      value.textContent = formatValue(item.value);
      svg.append(name, track, bar, value);
    });
  }

  function renderDonut(container, items, { label, formatValue }) {
    container.replaceChildren();
    const wrapper = document.createElement("div");
    wrapper.className = "chart-donut-layout";
    const svg = svgElement("svg", {
      viewBox: "0 0 220 220",
      role: "img",
      "aria-label": label,
    });
    const title = svgElement("title");
    title.textContent = label;
    svg.append(title);
    const radius = 72;
    const circumference = 2 * Math.PI * radius;
    const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0);
    let offset = 0;
    const background = svgElement("circle", {
      cx: 110,
      cy: 110,
      r: radius,
      class: "chart-donut-track",
    });
    svg.append(background);
    items.forEach((item, index) => {
      if (!total || !Number(item.value)) return;
      const length = (Number(item.value) / total) * circumference;
      const segment = svgElement("circle", {
        cx: 110,
        cy: 110,
        r: radius,
        class: `chart-donut-segment chart-series-stroke-${(index % 3) + 1}`,
        "stroke-dasharray": `${length} ${circumference - length}`,
        "stroke-dashoffset": -offset,
      });
      offset += length;
      svg.append(segment);
    });
    const totalLabel = svgElement("text", {
      x: 110,
      y: 105,
      class: "chart-donut-label",
      "text-anchor": "middle",
    });
    totalLabel.textContent = "Total pago";
    const totalValue = svgElement("text", {
      x: 110,
      y: 128,
      class: "chart-donut-value",
      "text-anchor": "middle",
    });
    totalValue.textContent = formatValue(total);
    svg.append(totalLabel, totalValue);

    const legend = document.createElement("ul");
    legend.className = "chart-legend";
    items.forEach((item, index) => {
      const entry = document.createElement("li");
      const marker = document.createElement("i");
      marker.className = `chart-series-${(index % 3) + 1}`;
      const text = document.createElement("span");
      text.textContent = `${item.label}: ${formatValue(item.value)}`;
      entry.append(marker, text);
      legend.append(entry);
    });
    wrapper.append(svg, legend);
    container.append(wrapper);
  }

  window.QuadrafyCharts = { renderBars, renderDonut, renderLine };
})();

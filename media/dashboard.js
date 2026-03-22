const vscode = acquireVsCodeApi();

// Initialize charts
const costChart = echarts.init(document.getElementById("cost-chart"));
const costPie = echarts.init(document.getElementById("cost-pie"));
const tokenChart = echarts.init(document.getElementById("token-chart"));
const tokenPie = echarts.init(document.getElementById("token-pie"));
const payloadChart = echarts.init(document.getElementById("payload-chart"));
const payloadPie = echarts.init(document.getElementById("payload-pie"));

// Resize handling
window.addEventListener("resize", () => {
  costChart.resize();
  costPie.resize();
  tokenChart.resize();
  tokenPie.resize();
  payloadChart.resize();
  payloadPie.resize();
});

// UI elements
const startDateInput = document.getElementById("start-date");
const endDateInput = document.getElementById("end-date");
const modelSelect = document.getElementById("model-select");

let rawLogsCache = []; // Store logs for fast re-rendering on model filter switch
let minDate = null; // Will be populated from backend

const dismissBtn = document.getElementById("dismiss-warning-btn");
if (dismissBtn) {
  dismissBtn.addEventListener("click", () => {
    console.log("Dismiss button clicked. Hiding UI alert and broadcasting to VS Code Backend...");
    document.getElementById("billing-warning").style.display = "none";
    vscode.postMessage({ command: "dismissWarning" });
  });
}

function populateModelDropdown(logs) {
  const currentVal = modelSelect.value;
  const uniqueModels = new Set();
  logs.forEach((l) => uniqueModels.add(l.model));

  let html = `<option value="all">All Models</option>`;
  Array.from(uniqueModels)
    .sort()
    .forEach((m) => {
      html += `<option value="${m}">${m}</option>`;
    });

  modelSelect.innerHTML = html;

  // Keep same model selected if it still exists in the new date range
  if (currentVal !== "all" && uniqueModels.has(currentVal)) {
    modelSelect.value = currentVal;
  }
}

modelSelect.addEventListener("change", () => {
  renderDashboard(rawLogsCache);
});

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function initDates() {
  const today = new Date();
  endDateInput.value = formatDate(today);

  const start = new Date(today);
  start.setDate(today.getDate() - 7);
  startDateInput.value = formatDate(start);
}

initDates();

function requestData() {
  vscode.postMessage({
    command: "fetchData",
    startDate: startDateInput.value,
    endDate: endDateInput.value,
  });
}

// Event Listeners for controls
document.getElementById("btn-today").addEventListener("click", () => {
  const t = new Date();
  startDateInput.value = formatDate(t);
  endDateInput.value = formatDate(t);
  requestData();
});
document.getElementById("btn-7days").addEventListener("click", () => {
  const t = new Date();
  endDateInput.value = formatDate(t);
  t.setDate(t.getDate() - 7);
  startDateInput.value = formatDate(t);
  requestData();
});
document.getElementById("btn-month").addEventListener("click", () => {
  const t = new Date();
  endDateInput.value = formatDate(t);
  t.setDate(1);
  startDateInput.value = formatDate(t);
  requestData();
});
document.getElementById("btn-all").addEventListener("click", () => {
  if (minDate) {
    startDateInput.value = minDate;
  } else {
    // Fallback: request min date from backend if not yet loaded
    vscode.postMessage({ command: "getMinDate" });
    setTimeout(() => {
      if (minDate) {
        startDateInput.value = minDate;
      } else {
        startDateInput.value = formatDate(new Date()); // Fallback: today
      }
      endDateInput.value = formatDate(new Date());
      requestData();
    }, 200);
    return;
  }
  endDateInput.value = formatDate(new Date());
  requestData();
});

startDateInput.addEventListener("change", requestData);
endDateInput.addEventListener("change", requestData);

// Listen to backend
window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "RENDER_DATA":
      rawLogsCache = message.payload;
      populateModelDropdown(rawLogsCache);
      renderDashboard(rawLogsCache);
      break;
    case "MIN_DATE":
      minDate = message.payload;
      break;
    case "UPDATE_SIGNAL": // backend pushed a refresh ping
      requestData();
      break;
  }
});

function renderDashboard(logs) {
  const selectedModel = modelSelect.value;
  if (selectedModel !== "all") {
    logs = logs.filter((log) => log.model === selectedModel);
  }

  let totalCost = 0;
  let totalTokens = 0;

  // Aggregations
  const costByModel = {};
  const tokensByModel = {};
  const datesMap = {}; // { 'YYYY-MM-DD': { model: cost } }
  const tokenSeriesMap = {}; // { 'YYYY-MM-DD': { input, output, cache_read, cache_create } }
  const payloadSeriesMap = {};

  // Fill maps with all dates in range to prevent gaps
  const startD = new Date(startDateInput.value);
  const endD = new Date(endDateInput.value);
  let currentD = new Date(startD);
  while (currentD <= endD) {
    const dtStr = formatDate(currentD);
    datesMap[dtStr] = {};
    tokenSeriesMap[dtStr] = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
    payloadSeriesMap[dtStr] = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };
    currentD.setDate(currentD.getDate() + 1);
  }

  const modelStats = {}; // for table

  logs.forEach((log) => {
    totalCost += log.cost;
    const tot = log.tokens.input + log.tokens.output + log.tokens.cache_read + log.tokens.cache_create;
    totalTokens += tot;

    costByModel[log.model] = (costByModel[log.model] || 0) + log.cost;
    tokensByModel[log.model] = (tokensByModel[log.model] || 0) + tot;

    if (!modelStats[log.model]) {
      modelStats[log.model] = { cost: 0, input: 0, output: 0, cached: 0, reqs: 0 };
    }
    modelStats[log.model].cost += log.cost;
    modelStats[log.model].input += log.tokens.input;
    modelStats[log.model].output += log.tokens.output;
    modelStats[log.model].cached += log.tokens.cache_read;
    modelStats[log.model].reqs += 1;

    // Use local timezone day for charts aggregation
    const logDateObj = new Date(log.timestamp);
    const ly = logDateObj.getFullYear();
    const lm = String(logDateObj.getMonth() + 1).padStart(2, "0");
    const ld = String(logDateObj.getDate()).padStart(2, "0");
    const dayStr = `${ly}-${lm}-${ld}`;

    if (!datesMap[dayStr]) {
      datesMap[dayStr] = {};
    }
    datesMap[dayStr][log.model] = (datesMap[dayStr][log.model] || 0) + log.cost;

    if (!tokenSeriesMap[dayStr]) {
      tokenSeriesMap[dayStr] = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
      payloadSeriesMap[dayStr] = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };
    }
    tokenSeriesMap[dayStr].input += log.tokens.input;
    tokenSeriesMap[dayStr].output += log.tokens.output;
    tokenSeriesMap[dayStr].cache_read += log.tokens.cache_read;
    tokenSeriesMap[dayStr].cache_create += log.tokens.cache_create;

    const chars = log.tokens.characters || { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };
    payloadSeriesMap[dayStr].system += chars.system || 0;
    payloadSeriesMap[dayStr].user_text += chars.user_text || 0;
    payloadSeriesMap[dayStr].assistant_text += chars.assistant_text || 0;
    payloadSeriesMap[dayStr].image += chars.image || 0;
    payloadSeriesMap[dayStr].tool_use += chars.tool_use || 0;
    payloadSeriesMap[dayStr].tool_result += chars.tool_result || 0;
  });

  // Update Cards
  document.getElementById("val-cost").innerText = `${totalCost.toFixed(2)} $`;
  document.getElementById("val-tokens").innerText = totalTokens.toLocaleString();

  // Find most used model
  let topModel = "--";
  let maxCost = 0;
  for (const [m, c] of Object.entries(costByModel)) {
    if (c > maxCost) {
      maxCost = c;
      topModel = m;
    }
  }
  document.getElementById("val-model").innerText = topModel;

  // Calculate global cache tokens
  let totalCached = 0;
  Object.values(modelStats).forEach((s) => (totalCached += s.cached));
  document.getElementById("val-savings").innerText = `${totalCached.toLocaleString()} tkns`;

  renderCharts(datesMap, tokenSeriesMap, costByModel, payloadSeriesMap);
  renderTable(modelStats);
}

function renderCharts(datesMap, tokenSeriesMap, costByModel, payloadSeriesMap) {
  const dates = Object.keys(datesMap).sort();
  const models = Object.keys(costByModel);

  // ECharts canvas doesn't auto-resolve CSS vars in options, so we extract it explicitly
  const textColor = getComputedStyle(document.body).getPropertyValue("--vscode-editor-foreground").trim() || "#cccccc";

  // Cost Chart
  const costSeries = models.map((m) => {
    return {
      name: m,
      type: "line",
      smooth: true,
      stack: "Total",
      areaStyle: {},
      emphasis: { focus: "series" },
      data: dates.map((d) => datesMap[d][m] || 0),
    };
  });

  costChart.setOption(
    {
      tooltip: {
        trigger: "axis",
        valueFormatter: (value) => Number(value).toFixed(2) + " $",
      },
      legend: { data: models, textStyle: { color: textColor } },
      xAxis: { type: "category", boundaryGap: false, data: dates, axisLabel: { color: textColor } },
      yAxis: { type: "value", axisLabel: { color: textColor } },
      series: costSeries,
      backgroundColor: "transparent",
    },
    true,
  );

  // Cost Pie
  costPie.setOption(
    {
      tooltip: {
        trigger: "item",
        valueFormatter: (value) => Number(value).toFixed(2) + " $",
      },
      series: [
        {
          type: "pie",
          radius: "50%",
          data: models.map((m) => ({ value: costByModel[m], name: m })),
          label: { color: textColor },
        },
      ],
      backgroundColor: "transparent",
    },
    true,
  );

  // Token Chart
  const tokenSeriesProps = ["input", "output", "cache_read", "cache_create"];
  const tokenSeries = tokenSeriesProps.map((prop) => ({
    name: prop,
    type: "bar",
    stack: "total",
    data: dates.map((d) => tokenSeriesMap[d][prop]),
  }));

  tokenChart.setOption(
    {
      tooltip: { trigger: "axis" },
      legend: { data: tokenSeriesProps, textStyle: { color: textColor } },
      xAxis: { type: "category", data: dates, axisLabel: { color: textColor } },
      yAxis: { type: "value", axisLabel: { color: textColor } },
      series: tokenSeries,
      backgroundColor: "transparent",
    },
    true,
  );

  // Token Pie
  let totalInput = 0,
    totalOut = 0,
    totalCR = 0,
    totalCC = 0;
  dates.forEach((d) => {
    totalInput += tokenSeriesMap[d].input;
    totalOut += tokenSeriesMap[d].output;
    totalCR += tokenSeriesMap[d].cache_read;
    totalCC += tokenSeriesMap[d].cache_create;
  });

  tokenPie.setOption(
    {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "pie",
          radius: "50%",
          data: [
            { name: "Input", value: totalInput },
            { name: "Output", value: totalOut },
            { name: "Cache Read", value: totalCR },
            { name: "Cache Create", value: totalCC },
          ],
          label: { color: textColor },
        },
      ],
      backgroundColor: "transparent",
    },
    true,
  );

  // Payload Chart
  const payloadSeriesProps = ["system", "user_text", "assistant_text", "image", "tool_use", "tool_result"];
  const payloadSeries = payloadSeriesProps.map((prop) => ({
    name: prop.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    type: "bar",
    stack: "total",
    data: dates.map((d) => payloadSeriesMap[d][prop]),
  }));

  payloadChart.setOption(
    {
      tooltip: { trigger: "axis" },
      legend: { data: payloadSeries.map((s) => s.name), textStyle: { color: textColor } },
      xAxis: { type: "category", data: dates, axisLabel: { color: textColor } },
      yAxis: { type: "value", axisLabel: { color: textColor } },
      series: payloadSeries,
      backgroundColor: "transparent",
    },
    true,
  );

  // Payload Pie
  let totalPayload = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };
  dates.forEach((d) => {
    payloadSeriesProps.forEach((p) => (totalPayload[p] += payloadSeriesMap[d][p]));
  });

  payloadPie.setOption(
    {
      tooltip: {
        trigger: "item",
        formatter: "{a} <br/>{b}: {c} chars ({d}%)",
      },
      series: [
        {
          name: "Characters Payload",
          type: "pie",
          radius: "50%",
          data: payloadSeriesProps
            .map((p) => ({
              name: p.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
              value: totalPayload[p],
            }))
            .filter((d) => d.value > 0),
          label: { formatter: "{b}\n{d}%", color: textColor },
        },
      ],
      backgroundColor: "transparent",
    },
    true,
  );
}

function renderTable(modelStats) {
  const tbody = document.querySelector("#summary-table tbody");
  tbody.innerHTML = "";

  // Sort array by cost descending
  const sorted = Object.entries(modelStats).sort((a, b) => b[1].cost - a[1].cost);

  for (const [m, s] of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
            <td>${m}</td>
            <td>${s.cost.toFixed(2)} $</td>
            <td>${s.input.toLocaleString()}</td>
            <td>${s.output.toLocaleString()}</td>
            <td>${s.cached.toLocaleString()}</td>
            <td>${s.reqs}</td>
        `;
    tbody.appendChild(tr);
  }
}

// Initial fetch
// Request minimum date from backend
vscode.postMessage({ command: "getMinDate" });
// Give small delay for UI
setTimeout(requestData, 50);

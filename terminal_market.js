(function() {
    const API_URL = "https://bizneys.com/api/v1/market";

    let rawMarketData = [];
    let filteredMarketData = [];
    let mainChartInstance = null;
    let nsiChartInstance = null;
    let gridApi = null;
    let isSeriesVisible = [true, true, true, true, true];
    let isSplitInitialized = false;

    /* ============================================================
     * Custom Chart.js plugins (registered once, reused by any chart
     * that opts in via its own `plugins.<id>` config block)
     * ============================================================ */

    /* Draws thin dashed horizontal reference lines at fixed y-values,
       e.g. the NSI "High Sync" / "Moderate" band boundaries. */
    /* Each entry in `lines` may be a plain number (drawn with the default light dashed
       style) or an { value, emphasis: true } object (drawn darker/heavier) — used to make
       upper/lower band boundaries stand out more than a center/zero line. */
    const thresholdLinesPlugin = {
        id: 'thresholdLines',
        afterDraw(chart, args, opts) {
            const lines = opts && opts.lines;
            if (!lines || !lines.length) return;
            const { ctx, chartArea, scales } = chart;
            if (!chartArea || !scales.y) return;
            ctx.save();
            lines.forEach((line) => {
                const isObj = typeof line === 'object' && line !== null;
                const val = isObj ? line.value : line;
                const emphasis = isObj && line.emphasis;
                ctx.setLineDash(emphasis ? [4, 2] : [3, 3]);
                ctx.strokeStyle = emphasis ? 'rgba(51, 65, 85, 0.55)' : 'rgba(100, 116, 139, 0.35)';
                ctx.lineWidth = emphasis ? 1.3 : 1;
                const y = scales.y.getPixelForValue(val);
                ctx.beginPath();
                ctx.moveTo(chartArea.left, y);
                ctx.lineTo(chartArea.right, y);
                ctx.stroke();
            });
            ctx.restore();
        }
    };

    /* Draws a faint brand watermark in the bottom-right corner of the chart canvas.
       Runs directly on the canvas pixels, so it is automatically included when the
       canvas is captured for the PNG snapshot feature below. */
    const brandWatermarkPlugin = {
        id: 'brandWatermark',
        afterDraw(chart, args, opts) {
            if (!opts || !opts.enabled) return;
            const { ctx, chartArea } = chart;
            if (!chartArea) return;
            ctx.save();
            ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = 'rgba(15, 23, 42, 0.18)';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText('BIZNEYS \u00B7 bizneys.com', chartArea.right, chartArea.bottom - 4);
            ctx.restore();
        }
    };

    Chart.register(thresholdLinesPlugin, brandWatermarkPlugin);

    /* ============================================================
     * Fullscreen Toggle
     * ============================================================ */
    window.toggleFullscreen = function() {
        const el = document.getElementById('marketTerminalWrapper');
        if (!document.fullscreenElement) {
            (el.requestFullscreen ? el.requestFullscreen() : Promise.resolve()).catch(() => {});
        } else {
            (document.exitFullscreen ? document.exitFullscreen() : Promise.resolve()).catch(() => {});
        }
    };

    document.addEventListener('fullscreenchange', () => {
        const el = document.getElementById('marketTerminalWrapper');
        const btn = document.getElementById('btnFullscreen');
        const isFs = document.fullscreenElement === el;
        el.classList.toggle('is-fullscreen', isFs);
        if (btn) btn.innerHTML = isFs ? '&#10005; Exit Fullscreen' : '&#9974; Fullscreen';
        /* Chart/grid containers changed size; give the browser a tick to reflow before resizing */
        setTimeout(() => {
            if (mainChartInstance) mainChartInstance.resize();
            if (nsiChartInstance) nsiChartInstance.resize();
            if (gridApi) gridApi.sizeColumnsToFit();
        }, 50);
    });

    /* ============================================================
     * PNG Snapshot Export (main + sub chart stacked into one image)
     * ============================================================ */
    window.downloadChartSnapshot = function() {
        const mainCanvas = document.getElementById('mainCanvas');
        const subCanvas = document.getElementById('nsiCanvas');
        if (!mainCanvas || !subCanvas) return;

        const gap = 16;
        const composite = document.createElement('canvas');
        composite.width = mainCanvas.width;
        composite.height = mainCanvas.height + subCanvas.height + gap;

        const ctx = composite.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, composite.width, composite.height);
        ctx.drawImage(mainCanvas, 0, 0);
        ctx.drawImage(subCanvas, 0, mainCanvas.height + gap);

        const link = document.createElement('a');
        link.download = 'bizneys_market_snapshot.png';
        link.href = composite.toDataURL('image/png');
        link.click();
    };

    /* Initialize draggable split layout for Desktop screens */
    function initSplitLayout() {
        if (isSplitInitialized) return;
        if (window.innerWidth >= 1024) {
            Split(['#chartBoxContainer', '#gridCardContainer'], {
                sizes: [55, 45], /* Chart pane kept slightly wider than the grid pane, unified with the Assets page */
                minSize: [300, 300],
                gutterSize: 6,
                cursor: 'col-resize',
                onDrag: () => {
                    if (mainChartInstance) mainChartInstance.resize();
                    if (nsiChartInstance) nsiChartInstance.resize();
                    if (gridApi) gridApi.sizeColumnsToFit();
                }
            });
            isSplitInitialized = true;
        }
    }

    /* Keep chart canvases and the grid's column widths in sync with viewport/container size
       changes (browser resize, mobile orientation change, sidebar toggles, etc). Chart.js
       redraws its own canvas via ResizeObserver, but AG Grid's column widths need an explicit
       sizeColumnsToFit() call, and the split layout only activates once the viewport crosses
       the 1024px breakpoint — so a resize that crosses that line needs to trigger it too. */
    let resizeDebounceTimer = null;
    function handleViewportResize() {
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
            initSplitLayout();
            if (mainChartInstance) mainChartInstance.resize();
            if (nsiChartInstance) nsiChartInstance.resize();
            if (gridApi) gridApi.sizeColumnsToFit();
        }, 150);
    }
    window.addEventListener('resize', handleViewportResize);
    window.addEventListener('orientationchange', handleViewportResize);

    function initTerminal() {
        if (typeof Chart === 'undefined' || typeof agGrid === 'undefined') {
            setTimeout(initTerminal, 100);
            return;
        }

        initSplitLayout();

        fetch(API_URL)
            .then(res => res.json())
            .then(data => {
                if (!data || data.length === 0) return;

                rawMarketData = data.map(d => ({
                    ...d,
                    x: new Date(d.date).getTime()
                })).sort((a, b) => a.x - b.x);

                filteredMarketData = [...rawMarketData];

                updateKPICards(rawMarketData);
                renderMainChart(filteredMarketData);
                renderNSIChart(filteredMarketData);
                renderSummaryGrid(filteredMarketData);
            })
            .catch(err => console.error("Error loading terminal data:", err));
    }

    function updateKPICards(data) {
        const latest = data[data.length - 1];
        const prev = data[data.length - 2] || latest;

        const setKPI = (valId, chgId, curr, previous) => {
            const valElem = document.getElementById(valId);
            const chgElem = document.getElementById(chgId);
            if (!valElem || !chgElem) return;

            valElem.innerText = (curr !== undefined && curr !== null) ? curr.toFixed(1) : "-";
            if (previous && previous !== 0) {
                const pct = ((curr - previous) / previous) * 100;
                chgElem.innerText = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
                chgElem.className = `kpi-change ${pct >= 0 ? 'up' : 'down'}`;
            }
        };

        setKPI("kpi-composite-val", "kpi-composite-chg", latest.COMPOSITE, prev.COMPOSITE);
        setKPI("kpi-sc-val", "kpi-sc-chg", latest.SC, prev.SC);
        setKPI("kpi-ah-val", "kpi-ah-chg", latest.AH, prev.AH);
        setKPI("kpi-h-val", "kpi-h-chg", latest.H, prev.H);
        setKPI("kpi-f-val", "kpi-f-chg", latest.F, prev.F);

        const nsiVal = latest.nsi_standardized;
        const nsiValElem = document.getElementById("kpi-nsi-val");
        const nsiStatusElem = document.getElementById("kpi-nsi-status");

        if (nsiVal !== null && nsiVal !== undefined) {
            nsiValElem.innerText = nsiVal.toFixed(2);

            if (nsiVal >= 0.70) {
                nsiStatusElem.innerText = "High Sync";
                nsiStatusElem.className = "kpi-change high";
            } else if (nsiVal >= 0.30) {
                nsiStatusElem.innerText = "Moderate";
                nsiStatusElem.className = "kpi-change moderate";
            } else {
                nsiStatusElem.innerText = "Low Sync";
                nsiStatusElem.className = "kpi-change low";
            }
        } else {
            nsiValElem.innerText = "N/A";
            nsiStatusElem.innerText = "-";
        }
    }

    function syncSubChartZoom(min, max) {
        if (nsiChartInstance && nsiChartInstance.scales.x) {
            nsiChartInstance.options.scales.x.min = min;
            nsiChartInstance.options.scales.x.max = max;
            nsiChartInstance.update('none');
        }
    }

    function syncMainChartZoom(min, max) {
        if (mainChartInstance && mainChartInstance.scales.x) {
            mainChartInstance.options.scales.x.min = min;
            mainChartInstance.options.scales.x.max = max;
            mainChartInstance.update('none');
        }
    }

    /* Custom Drag & Wheel & Mobile 2-Finger Zoom Handler */
    function attachChartDragInteractions(canvasId, chartGetter) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        let isDragging = false;
        let isYScaleDrag = false;
        let startX = 0;
        let startY = 0;

        let startXMin = 0;
        let startXMax = 0;
        let startYMin = 0;
        let startYMax = 0;

        /* Mobile 2-Finger Touch Pinch Tracking */
        let touchPinchInitialDistance = 0;
        let initialTouchXMin = 0;
        let initialTouchXMax = 0;

        const getTouchDistance = (e) => {
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        };

        const isOverYAxis = (clientX) => {
            const chart = chartGetter();
            if (!chart) return false;
            const rect = canvas.getBoundingClientRect();
            const x = clientX - rect.left;
            const yScale = chart.scales.y;
            return (x >= yScale.left && x <= yScale.right);
        };

        const updateCursor = (clientX) => {
            if (isOverYAxis(clientX)) {
                canvas.style.cursor = 'ns-resize';
            } else {
                canvas.style.cursor = 'crosshair';
            }
        };

        canvas.addEventListener('mousemove', (e) => {
            if (!isDragging) {
                updateCursor(e.clientX);
            }
        });

        const handleStart = (e) => {
            const chart = chartGetter();
            if (!chart) return;

            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (!clientX || !clientY) return;

            isDragging = true;
            startX = clientX;
            startY = clientY;

            startXMin = chart.scales.x.min;
            startXMax = chart.scales.x.max;
            startYMin = chart.scales.y.min;
            startYMax = chart.scales.y.max;

            if (isOverYAxis(clientX)) {
                isYScaleDrag = true;
                document.body.style.cursor = 'ns-resize';
            } else {
                isYScaleDrag = false;
                document.body.style.cursor = 'crosshair';
            }
        };

        const handleMove = (e) => {
            if (!isDragging) return;

            const chart = chartGetter();
            if (!chart) return;

            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (!clientX || !clientY) return;

            const deltaX = clientX - startX;
            const deltaY = clientY - startY;

            if (isYScaleDrag) {
                /* Dragging on Right Price Scale Area: Scale Height Adjustment */
                const rangeY = startYMax - startYMin;
                const scaleFactor = 1 + (deltaY / 150);

                if (scaleFactor > 0.05) {
                    const center = (startYMin + startYMax) / 2;
                    const newHalfRange = (rangeY * scaleFactor) / 2;

                    chart.options.scales.y.min = Math.max(0, center - newHalfRange);
                    chart.options.scales.y.max = center + newHalfRange;
                    chart.update('none');
                }
            } else {
                /* Dragging Inside Chart Area: Full Horizontal & Vertical Drag Pan */
                const xAxis = chart.scales.x;
                const yAxis = chart.scales.y;

                const xRange = startXMax - startXMin;
                const xPixelWidth = xAxis.right - xAxis.left;
                const xShift = (deltaX / xPixelWidth) * xRange;

                const yRange = startYMax - startYMin;
                const yPixelHeight = yAxis.bottom - yAxis.top;
                const yShift = (deltaY / yPixelHeight) * yRange;

                const newXMin = startXMin - xShift;
                const newXMax = startXMax - xShift;
                const newYMin = startYMin + yShift;
                const newYMax = startYMax + yShift;

                chart.options.scales.x.min = newXMin;
                chart.options.scales.x.max = newXMax;
                chart.options.scales.y.min = newYMin;
                chart.options.scales.y.max = newYMax;

                chart.update('none');

                syncMainChartZoom(newXMin, newXMax);
                syncSubChartZoom(newXMin, newXMax);
            }
        };

        const handleEnd = () => {
            if (isDragging) {
                isDragging = false;
                isYScaleDrag = false;
                document.body.style.cursor = 'default';
            }
        };

        /* Wheel Scroll Zoom Handling */
        const handleWheel = (e) => {
            e.preventDefault();
            const chart = chartGetter();
            if (!chart) return;

            const zoomFactor = e.deltaY < 0 ? 0.9 : 1.1;

            if (isOverYAxis(e.clientX)) {
                /* Scroll over Price Axis: Y-Axis Price Zoom */
                const currentMin = chart.scales.y.min;
                const currentMax = chart.scales.y.max;
                const range = currentMax - currentMin;
                const center = (currentMin + currentMax) / 2;
                const newHalfRange = (range * zoomFactor) / 2;

                chart.options.scales.y.min = Math.max(0, center - newHalfRange);
                chart.options.scales.y.max = center + newHalfRange;
                chart.update('none');
            } else {
                /* Scroll Inside Chart Body: X-Axis Time Zoom */
                const currentMin = chart.scales.x.min;
                const currentMax = chart.scales.x.max;
                const range = currentMax - currentMin;

                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const xAxis = chart.scales.x;
                const mouseRatio = Math.max(0, Math.min(1, (mouseX - xAxis.left) / (xAxis.right - xAxis.left)));

                const newRange = range * zoomFactor;
                const newMin = currentMin + (range - newRange) * mouseRatio;
                const newMax = newMin + newRange;

                chart.options.scales.x.min = newMin;
                chart.options.scales.x.max = newMax;
                chart.update('none');

                syncMainChartZoom(newMin, newMax);
                syncSubChartZoom(newMin, newMax);
            }
        };

        canvas.addEventListener('mousedown', handleStart);
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleEnd);
        canvas.addEventListener('wheel', handleWheel, { passive: false });

        /* Mobile Touch Events (1-Finger Pan & 2-Finger Pinch Zoom) */
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches && e.touches.length === 1) {
                handleStart(e);
            } else if (e.touches && e.touches.length === 2) {
                /* Initialize 2-finger pinch gesture */
                isDragging = false;
                const chart = chartGetter();
                if (!chart) return;

                touchPinchInitialDistance = getTouchDistance(e);
                initialTouchXMin = chart.scales.x.min;
                initialTouchXMax = chart.scales.x.max;
            }
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (e.touches && e.touches.length === 1 && isDragging) {
                handleMove(e);
            } else if (e.touches && e.touches.length === 2) {
                /* Handle 2-finger pinch zoom */
                const chart = chartGetter();
                if (!chart || touchPinchInitialDistance <= 0) return;

                const currentDistance = getTouchDistance(e);
                const scaleRatio = touchPinchInitialDistance / currentDistance;

                const currentRange = initialTouchXMax - initialTouchXMin;
                const centerTime = (initialTouchXMin + initialTouchXMax) / 2;
                const newHalfRange = (currentRange * scaleRatio) / 2;

                const newMin = centerTime - newHalfRange;
                const newMax = centerTime + newHalfRange;

                chart.options.scales.x.min = newMin;
                chart.options.scales.x.max = newMax;
                chart.update('none');

                syncMainChartZoom(newMin, newMax);
                syncSubChartZoom(newMin, newMax);
            }
        }, { passive: true });

        window.addEventListener('touchend', (e) => {
            if (e.touches && e.touches.length < 2) {
                touchPinchInitialDistance = 0;
            }
            handleEnd();
        });
    }

    function renderMainChart(data) {
        const ctx = document.getElementById('mainCanvas').getContext('2d');
        if (mainChartInstance) mainChartInstance.destroy();

        const minTimestamp = data[0].x;
        const maxTimestamp = data[data.length - 1].x;

        mainChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    { label: 'BIZNEYS Composite 100 Index (BIZNEYS 100)', data: data.map(d => ({ x: d.x, y: d.COMPOSITE })), borderColor: '#4338ca', borderWidth: 2.2, pointRadius: 0 },
                    { label: 'Singularity Core (SC)', data: data.map(d => ({ x: d.x, y: d.SC })), borderColor: '#dc2626', borderWidth: 1.2, pointRadius: 0 },
                    { label: 'Augmented Humanity (AH)', data: data.map(d => ({ x: d.x, y: d.AH })), borderColor: '#06b6d4', borderWidth: 1.2, pointRadius: 0 },
                    { label: 'Humanity (H)', data: data.map(d => ({ x: d.x, y: d.H })), borderColor: '#ea580c', borderWidth: 1.2, pointRadius: 0 },
                    { label: 'Foundation (F)', data: data.map(d => ({ x: d.x, y: d.F })), borderColor: '#64748b', borderWidth: 1.2, pointRadius: 0 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                layout: {
                    padding: { left: 10, right: 0, top: 0, bottom: 0 }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                    brandWatermark: { enabled: true } /* Only stamped on the main chart to avoid visual clutter */
                },
                scales: {
                    x: {
                        type: 'time',
                        min: minTimestamp,
                        max: maxTimestamp,
                        ticks: {
                            /* Use the same font size as the NSI chart's ticks so autoSkip measures
                               label width identically and produces the same tick spacing. Using
                               display:false here would skip label-width measurement entirely and
                               pack in far more gridlines than the NSI chart below. Making the
                               labels transparent keeps the spacing in sync while staying invisible. */
                            color: 'transparent',
                            font: { size: 9 },
                            maxRotation: 0,
                            autoSkip: true
                        },
                        grid: {
                            display: true,
                            color: '#f1f5f9'
                        },
                        afterFit: (axis) => { axis.height = 0; } /* Reclaim the space reserved for the now-invisible labels */
                    },
                    y: {
                        position: 'right',
                        min: 0,
                        grid: { display: true, color: '#f1f5f9' },
                        ticks: {
                            font: { size: 9 },
                            padding: 4
                        },
                        afterFit: (axis) => { axis.width = 55; }
                    }
                }
            }
        });

        isSeriesVisible.forEach((visible, idx) => {
            mainChartInstance.setDatasetVisibility(idx, visible);
        });
        mainChartInstance.update('none');

        attachChartDragInteractions('mainCanvas', () => mainChartInstance);
    }

    function renderNSIChart(data) {
        const ctx = document.getElementById('nsiCanvas').getContext('2d');
        if (nsiChartInstance) nsiChartInstance.destroy();

        const minTimestamp = data[0].x;
        const maxTimestamp = data[data.length - 1].x;

        nsiChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'NSI',
                    data: data.map(d => ({ x: d.x, y: d.nsi_standardized })),
                    borderColor: '#059669',
                    borderWidth: 1.2,
                    fill: true,
                    backgroundColor: 'rgba(5, 150, 105, 0.06)',
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                layout: {
                    padding: { left: 10, right: 0, top: 0, bottom: 0 }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                    /* Reference lines at the same High Sync (0.75) / Moderate (0.45) boundaries
                       used by the NSI KPI card, so the band is visible on the chart too. Drawn
                       with emphasis (darker/heavier) since these are the upper/lower band edges. */
                    thresholdLines: { lines: [{ value: 0.75, emphasis: true }, { value: 0.45, emphasis: true }] }
                },
                scales: {
                    x: {
                        type: 'time',
                        min: minTimestamp,
                        max: maxTimestamp,
                        ticks: {
                            font: { size: 9 },
                            maxRotation: 0,
                            autoSkip: true
                        },
                        grid: {
                            display: true,
                            color: '#f1f5f9'
                        }
                        /* Removed afterBuildTicks tick-copying hack: both charts now use the same
                           autoSkip/maxRotation tick config directly, so their gridlines line up
                           without one chart overwriting the other's computed ticks. */
                    },
                    y: {
                        position: 'right',
                        min: 0,
                        max: 1,
                        grid: { display: true, color: '#f1f5f9' },
                        ticks: { font: { size: 8 }, stepSize: 0.5 },
                        afterFit: (axis) => { axis.width = 55; }
                    }
                }
            }
        });

        attachChartDragInteractions('nsiCanvas', () => nsiChartInstance);
    }

    window.resetChartZoom = function() {
        if (mainChartInstance && filteredMarketData.length) {
            const minTimestamp = filteredMarketData[0].x;
            const maxTimestamp = filteredMarketData[filteredMarketData.length - 1].x;

            mainChartInstance.options.scales.x.min = minTimestamp;
            mainChartInstance.options.scales.x.max = maxTimestamp;
            mainChartInstance.options.scales.y.min = 0;
            delete mainChartInstance.options.scales.y.max;
            mainChartInstance.update();

            if (nsiChartInstance) {
                nsiChartInstance.options.scales.x.min = minTimestamp;
                nsiChartInstance.options.scales.x.max = maxTimestamp;
                nsiChartInstance.options.scales.y.min = 0;
                nsiChartInstance.options.scales.y.max = 1;
                nsiChartInstance.update();
            }
        }
    };

    window.toggleSeries = function(index) {
        if (!mainChartInstance) return;
        const isVisible = mainChartInstance.isDatasetVisible(index);

        if (isVisible) {
            mainChartInstance.hide(index);
            isSeriesVisible[index] = false;
        } else {
            mainChartInstance.show(index);
            isSeriesVisible[index] = true;
        }
    };

    window.setTimeRange = function(range, btnElem) {
        document.querySelectorAll('.btn-range').forEach(b => b.classList.remove('active'));
        if (btnElem) btnElem.classList.add('active');

        if (!rawMarketData.length) return;

        const latestDate = new Date(rawMarketData[rawMarketData.length - 1].x);
        let startDate = new Date(latestDate);

        if (range === '1M') startDate.setMonth(startDate.getMonth() - 1);
        else if (range === '3M') startDate.setMonth(startDate.getMonth() - 3);
        else if (range === '6M') startDate.setMonth(startDate.getMonth() - 6);
        else if (range === '1Y') startDate.setFullYear(startDate.getFullYear() - 1);
        else startDate = new Date(rawMarketData[0].x);

        filteredMarketData = rawMarketData.filter(d => d.x >= startDate.getTime());

        renderMainChart(filteredMarketData);
        renderNSIChart(filteredMarketData);

        if (gridApi) {
            gridApi.setGridOption('rowData', filteredMarketData);
        }
    };

    function renderSummaryGrid(data) {
        const gridOptions = {
            columnDefs: [
                { field: "date", headerName: "Date", sort: "desc", flex: 1, minWidth: 80 },
                {
                    field: "COMPOSITE",
                    headerName: "BIZNEYS 100",
                    headerTooltip: "BIZNEYS Composite 100 Index",
                    valueFormatter: p => p.value?.toFixed(1),
                    flex: 1,
                    minWidth: 90
                },
                {
                    field: "SC",
                    headerName: "SC",
                    headerTooltip: "Singularity Core (SC)",
                    valueFormatter: p => p.value?.toFixed(1),
                    flex: 1,
                    minWidth: 65
                },
                {
                    field: "AH",
                    headerName: "AH",
                    headerTooltip: "Augmented Humanity (AH)",
                    valueFormatter: p => p.value?.toFixed(1),
                    flex: 1,
                    minWidth: 65
                },
                {
                    field: "H",
                    headerName: "H",
                    headerTooltip: "Humanity (H)",
                    valueFormatter: p => p.value?.toFixed(1),
                    flex: 1,
                    minWidth: 60
                },
                {
                    field: "F",
                    headerName: "F",
                    headerTooltip: "Foundation (F)",
                    valueFormatter: p => p.value?.toFixed(1),
                    flex: 1,
                    minWidth: 60
                },
                {
                    field: "nsi_standardized",
                    headerName: "NSI",
                    headerTooltip: "Narrative Synchronization Index (NSI)",
                    valueFormatter: p => p.value !== null ? p.value.toFixed(2) : "N/A",
                    flex: 0.8,
                    minWidth: 55
                }
            ],
            rowData: data,
            pagination: true,
            paginationPageSize: 10,
            suppressHorizontalScroll: false,
            suppressCellFocus: true,
            suppressRowClickSelection: true,
            defaultColDef: { resizable: true, sortable: true, filter: true },
            onGridReady: (params) => {
                gridApi = params.api;
                gridApi.sizeColumnsToFit();
            },
            onGridSizeChanged: (params) => {
                if (params.api) params.api.sizeColumnsToFit();
            }
        };

        const gridDiv = document.getElementById('marketSummaryGrid');
        gridDiv.innerHTML = '';
        gridApi = agGrid.createGrid(gridDiv, gridOptions);
    }

    window.exportCSV = function() {
        if (gridApi) gridApi.exportDataAsCsv({ fileName: 'bizneys_market_data.csv' });
    };

    document.addEventListener("DOMContentLoaded", initTerminal);
    initTerminal();
})();

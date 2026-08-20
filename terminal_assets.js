(function() {
    const API_LATEST_URL = "https://bizneys.com/api/v1/assets/latest";
    const API_TIMESERIES_URL = "https://bizneys.com/api/v1/assets/timeseries/";

    /* Full names behind each narrative-factor short code, reused for grid tooltips and the
       chart's exposures legend so "SC / AH / H / F" are never shown without their meaning. */
    const NARRATIVE_FACTOR_NAMES = {
        SC: 'Singularity Core',
        AH: 'Augmented Humanity',
        H: 'Humanity',
        F: 'Foundation'
    };

    let screenerGridApi = null;
    let assetSnapshotData = [];

    let selectedTicker = null;
    let selectedName = null;
    let assetRawSeries = [];       /* Full time-series for the selected ticker */
    let assetFilteredSeries = [];  /* Range-filtered slice currently rendered */

    let assetMainChartInstance = null;
    let assetSubChartInstance = null;

    let currentSubTab = 'premium';
    let isMAVisible = [true, false, false, false]; /* index 0 = price (always on), 1 = MA20, 2 = MA50, 3 = MA200 */

    /* TradingView Style: Active timeframe mode for moving averages ('1D', '1W', '1M') */
    let currentMATimeframe = '1D';

    /* ============================================================
     * Custom Chart.js plugins (registered once, reused by any chart
     * that opts in via its own `plugins.<id>` config block)
     * ============================================================ */

    /* Draws thin dashed horizontal reference lines at fixed y-values (e.g. the zero line for
       exposures / alpha, or the zero + one-std-dev band for narrative premium below). */
    const thresholdLinesPlugin = {
        id: 'thresholdLines',
        afterDraw(chart, args, opts) {
            const lines = opts && opts.lines;
            if (!lines || !lines.length) return;
            const { ctx, chartArea, scales } = chart;
            if (!chartArea || !scales.y) return;
            ctx.save();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = 'rgba(100, 116, 139, 0.35)';
            ctx.lineWidth = 1;
            lines.forEach((val) => {
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
        const el = document.getElementById('assetTerminalWrapper');
        if (!document.fullscreenElement) {
            (el.requestFullscreen ? el.requestFullscreen() : Promise.resolve()).catch(() => {});
        } else {
            (document.exitFullscreen ? document.exitFullscreen() : Promise.resolve()).catch(() => {});
        }
    };

    document.addEventListener('fullscreenchange', () => {
        const el = document.getElementById('assetTerminalWrapper');
        const btn = document.getElementById('btnFullscreen');
        const isFs = document.fullscreenElement === el;
        el.classList.toggle('is-fullscreen', isFs);
        if (btn) btn.innerHTML = isFs ? '&#10005; Exit Fullscreen' : '&#9974; Fullscreen';
        setTimeout(() => {
            if (assetMainChartInstance) assetMainChartInstance.resize();
            if (assetSubChartInstance) assetSubChartInstance.resize();
            if (screenerGridApi) screenerGridApi.sizeColumnsToFit();
        }, 50);
    });

    /* ============================================================
     * PNG Snapshot Export (main + sub chart stacked into one image)
     * ============================================================ */
    window.downloadChartSnapshot = function() {
        const mainCanvas = document.getElementById('assetMainCanvas');
        const subCanvas = document.getElementById('assetSubCanvas');
        if (!mainCanvas || !subCanvas || !assetMainChartInstance) return;

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
        link.download = `bizneys_asset_snapshot_${selectedTicker || 'chart'}.png`;
        link.href = composite.toDataURL('image/png');
        link.click();
    };

    /* ============================================================
     * Split.js Layout: Chart (left) / Screener Grid (right)
     * ============================================================ */
    function initSplitLayout() {
        if (window.innerWidth >= 1024) {
            Split(['#chartBoxContainer', '#gridCardContainer'], {
                sizes: [55, 45], /* Unified with the Market page: chart pane kept slightly wider */
                minSize: [320, 380],
                gutterSize: 6,
                cursor: 'col-resize',
                onDrag: () => {
                    if (assetMainChartInstance) assetMainChartInstance.resize();
                    if (assetSubChartInstance) assetSubChartInstance.resize();
                    if (screenerGridApi) screenerGridApi.sizeColumnsToFit();
                }
            });
        }
    }

    /* ============================================================
     * Screener Grid (right pane)
     * ============================================================ */
    function initScreener() {
        if (typeof Chart === 'undefined' || typeof agGrid === 'undefined') {
            setTimeout(initScreener, 100);
            return;
        }

        initSplitLayout();

        fetch(API_LATEST_URL)
            .then(res => res.json())
            .then(data => {
                assetSnapshotData = data || [];
                assetSnapshotData.sort((a, b) => (a.ticker || '').localeCompare(b.ticker || ''));

                renderScreenerGrid(assetSnapshotData);
                updateRowCountLabel(assetSnapshotData.length, assetSnapshotData.length);

                const dateLabel = assetSnapshotData.length ? assetSnapshotData[0].date : '-';
                document.getElementById('assetSubtitle').innerText =
                    `${assetSnapshotData.length.toLocaleString()} assets \u00B7 Snapshot as of ${dateLabel}`;

                if (assetSnapshotData.length) {
                    selectAsset(assetSnapshotData[0].ticker, assetSnapshotData[0].name);
                }
            })
            .catch(err => {
                console.error("Error loading asset snapshot:", err);
                document.getElementById('assetSubtitle').innerText = "Failed to load universe";
            });
    }

    function signedPercentFormatter(params) {
        if (params.value === null || params.value === undefined) return "-";
        const pct = params.value * 100;
        return (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
    }
    function signedNumberFormatter(decimals) {
        return (params) => {
            if (params.value === null || params.value === undefined) return "-";
            return (params.value >= 0 ? "+" : "") + params.value.toFixed(decimals);
        };
    }
    function signedCellStyle(params) {
        if (params.value === null || params.value === undefined) return null;
        return { color: params.value >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 };
    }
    const compactVolumeFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

    function renderScreenerGrid(data) {
        const gridOptions = {
            columnDefs: [
                { field: "ticker", headerName: "Ticker", sort: "asc", pinned: 'left', minWidth: 90, cellClass: 'ag-ticker-cell' },
                { field: "name", headerName: "Name", minWidth: 160, flex: 1.4 },
                { field: "adj_close", headerName: "Adj Close", minWidth: 100, flex: 1, valueFormatter: p => p.value?.toFixed(2) },
                { field: "volume", headerName: "Volume", minWidth: 90, flex: 1, valueFormatter: p => p.value !== null && p.value !== undefined ? compactVolumeFormatter.format(p.value) : "-" },
                { field: "daily_return", headerName: "Daily Return", minWidth: 100, flex: 1, valueFormatter: signedPercentFormatter, cellStyle: signedCellStyle },
                {
                    headerName: "Narrative Exposures (\u03B2)",
                    headerTooltip: "Sensitivity of the asset's returns to each narrative factor",
                    children: [
                        { field: "beta_sc", headerName: "\u03B2 SC", headerTooltip: NARRATIVE_FACTOR_NAMES.SC, minWidth: 70, flex: 0.8, valueFormatter: p => p.value?.toFixed(2) },
                        { field: "beta_ah", headerName: "\u03B2 AH", headerTooltip: NARRATIVE_FACTOR_NAMES.AH, minWidth: 70, flex: 0.8, valueFormatter: p => p.value?.toFixed(2) },
                        { field: "beta_h", headerName: "\u03B2 H", headerTooltip: NARRATIVE_FACTOR_NAMES.H, minWidth: 65, flex: 0.8, valueFormatter: p => p.value?.toFixed(2) },
                        { field: "beta_f", headerName: "\u03B2 F", headerTooltip: NARRATIVE_FACTOR_NAMES.F, minWidth: 65, flex: 0.8, valueFormatter: p => p.value?.toFixed(2) }
                    ]
                },
                { field: "alpha", headerName: "\u03B1 Alpha", headerTooltip: "Return unexplained by narrative factor exposure", minWidth: 90, flex: 1, valueFormatter: signedNumberFormatter(3), cellStyle: signedCellStyle },
                { field: "narrative_premium", headerName: "Narrative Premium", minWidth: 110, flex: 1.1, valueFormatter: signedNumberFormatter(3), cellStyle: signedCellStyle }
            ],
            rowData: data,
            pagination: true,
            paginationPageSize: 50,
            paginationPageSizeSelector: [25, 50, 100, 200],
            suppressCellFocus: true,
            suppressRowClickSelection: true,
            defaultColDef: { resizable: true, sortable: true, filter: true },
            rowClassRules: {
                'ag-row-selected-ticker': (params) => params.data && params.data.ticker === selectedTicker
            },
            onGridReady: (params) => {
                screenerGridApi = params.api;
                screenerGridApi.sizeColumnsToFit();
            },
            onRowClicked: (params) => {
                if (params.data) selectAsset(params.data.ticker, params.data.name);
            },
            onFilterChanged: () => {
                updateRowCountLabel(screenerGridApi.getDisplayedRowCount(), assetSnapshotData.length);
            }
        };

        const gridDiv = document.getElementById('assetScreenerGrid');
        gridDiv.innerHTML = '';
        screenerGridApi = agGrid.createGrid(gridDiv, gridOptions);
    }

    function updateRowCountLabel(shown, total) {
        const label = document.getElementById('assetRowCountLabel');
        label.innerText = shown === total
            ? `${total.toLocaleString()} assets`
            : `${shown.toLocaleString()} / ${total.toLocaleString()} assets`;
    }

    /* Exports the currently visible/filtered screener grid (cross-sectional snapshot) */
    window.exportAssetsCSV = function() {
        if (screenerGridApi) screenerGridApi.exportDataAsCsv({ fileName: 'bizneys_asset_screener.csv' });
    };

    /* Exports the selected asset's own full time-series (not the cross-sectional grid) */
    window.downloadAssetTimeseriesCSV = function() {
        if (!selectedTicker || !assetRawSeries.length) return;

        const columns = ['date', 'ticker', 'name', 'adj_close', 'volume', 'daily_return', 'beta_sc', 'beta_ah', 'beta_h', 'beta_f', 'alpha', 'narrative_premium'];
        const rows = [columns.join(',')];

        assetRawSeries.forEach((d) => {
            const row = columns.map((col) => {
                if (col === 'name') return `"${(selectedName || '').replace(/"/g, '""')}"`;
                const val = d[col];
                return (val === null || val === undefined) ? '' : val;
            });
            rows.push(row.join(','));
        });

        const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `bizneys_asset_timeseries_${selectedTicker}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    };

    /* ============================================================
     * Left Panel: Docked Chart.js Chart (Main + Sub tabs)
     * ============================================================ */

    function selectAsset(ticker, name) {
        selectedTicker = ticker;
        selectedName = name;

        document.getElementById('chartPanelPlaceholder').style.display = 'none';
        document.getElementById('chartPanelSelected').style.display = 'flex';
        document.getElementById('chartPanelTicker').innerText = ticker;
        document.getElementById('chartPanelName').innerText = name || '';

        document.getElementById('chartPanelEmpty').style.display = 'none';
        document.getElementById('chartPanelLoading').style.display = 'flex';
        document.getElementById('chartPanelLoading').innerText = 'Loading time-series...';
        document.getElementById('chartPanelContent').style.display = 'none';

        /* Reset per-selection UI state */
        currentSubTab = 'premium';
        isMAVisible = [true, false, false, false];
        currentMATimeframe = '1D';
        document.getElementById('chk-ma20').checked = false;
        document.getElementById('chk-ma50').checked = false;
        document.getElementById('chk-ma200').checked = false;
        document.querySelectorAll('.btn-tab').forEach(b => b.classList.remove('active'));
        document.querySelector('.btn-tab[data-tab="premium"]').classList.add('active');
        document.querySelectorAll('.range-selector .btn-range').forEach(b => b.classList.remove('active'));
        document.querySelector('.range-selector .btn-range:last-child').classList.add('active');
        renderSubTabLegend('premium');

        if (screenerGridApi) screenerGridApi.redrawRows();

        loadAssetTimeseries(ticker);
    }

    function loadAssetTimeseries(ticker) {
        fetch(API_TIMESERIES_URL + encodeURIComponent(ticker))
            .then(res => res.json())
            .then(data => {
                if (!data || data.length === 0) {
                    document.getElementById('chartPanelLoading').innerText = "No data available for this ticker.";
                    return;
                }

                assetRawSeries = data
                    .map(d => ({ ...d, x: new Date(d.date).getTime() }))
                    .sort((a, b) => a.x - b.x);

                attachMovingAverages(assetRawSeries);
                assetFilteredSeries = [...assetRawSeries];

                document.getElementById('chartPanelLoading').style.display = 'none';
                document.getElementById('chartPanelContent').style.display = 'block';

                renderAssetMainChart(assetFilteredSeries);
                renderAssetSubChart(assetFilteredSeries, currentSubTab);
            })
            .catch(err => {
                console.error("Error loading asset timeseries:", err);
                document.getElementById('chartPanelLoading').innerText = "Failed to load time-series.";
            });
    }

    /* Standard Simple Moving Average (SMA) calculation function */
    function computeMovingAverage(series, field, period) {
        if (!series || !series.length) return new Array(0).fill(null);

        const result = new Array(series.length).fill(null);
        let windowSum = 0;

        for (let i = 0; i < series.length; i++) {
            windowSum += series[i][field];
            if (i >= period) {
                windowSum -= series[i - period][field];
            }
            if (i >= period - 1) {
                result[i] = windowSum / period;
            }
        }
        return result;
    }

    /* Calculates MA periods based on selected timeframe scale (1D = 1x, 1W = 5x, 1M = 20x) */
    function attachMovingAverages(series) {
        let multiplier = 1;
        if (currentMATimeframe === '1W') multiplier = 5;
        if (currentMATimeframe === '1M') multiplier = 20;

        const ma20 = computeMovingAverage(series, 'adj_close', 20 * multiplier);
        const ma50 = computeMovingAverage(series, 'adj_close', 50 * multiplier);
        const ma200 = computeMovingAverage(series, 'adj_close', 200 * multiplier);

        series.forEach((d, i) => {
            d.ma20 = ma20[i];
            d.ma50 = ma50[i];
            d.ma200 = ma200[i];
        });
    }

    /* Range selector handler supporting automatic TradingView-style MA timeframe switching */
    window.filterAssetRange = function(rangeKey, btn) {
        ...
        if (rangeKey === '1M' || rangeKey === '3M') currentMATimeframe = '1D';
        else if (rangeKey === '6M' || rangeKey === '1Y') currentMATimeframe = '1W';
        else if (rangeKey === 'ALL') currentMATimeframe = '1M';
    
        if (!assetRawSeries || !assetRawSeries.length) return;
    
        attachMovingAverages(assetRawSeries);
    
        assetFilteredSeries = assetRawSeries.filter(d => d.x >= minTimestamp);
    
        renderAssetMainChart(assetFilteredSeries);
        renderAssetSubChart(assetFilteredSeries, currentSubTab);
    };

        /* Recompute MA across full dataset before filtering slice */
        attachMovingAverages(assetRawSeries);

        const maxTimestamp = assetRawSeries[assetRawSeries.length - 1].x;
        let minTimestamp = 0;
        const now = new Date(maxTimestamp);

        if (rangeKey === '1M') minTimestamp = new Date(now).setMonth(now.getMonth() - 1);
        else if (rangeKey === '3M') minTimestamp = new Date(now).setMonth(now.getMonth() - 3);
        else if (rangeKey === '6M') minTimestamp = new Date(now).setMonth(now.getMonth() - 6);
        else if (rangeKey === '1Y') minTimestamp = new Date(now).setFullYear(now.getFullYear() - 1);
        else if (rangeKey === 'ALL') minTimestamp = 0;

        assetFilteredSeries = assetRawSeries.filter(d => d.x >= minTimestamp);

        renderAssetMainChart(assetFilteredSeries);
        renderAssetSubChart(assetFilteredSeries, currentSubTab);
    };

    /* Toggle visibility for MA datasets */
    window.toggleAssetMA = function(index, checked) {
        isMAVisible[index] = checked;
        if (assetMainChartInstance) {
            assetMainChartInstance.data.datasets[index].hidden = !checked;
            assetMainChartInstance.update();
        }
    };

/* ---- Shared drag / wheel / pinch interaction handler ---- */
    function attachChartDragInteractions(canvasId, chartGetter, onZoomChange) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        let isDragging = false;
        let isYScaleDrag = false;
        let startX = 0;
        let startY = 0;
        let startXMin = 0, startXMax = 0, startYMin = 0, startYMax = 0;

        let touchPinchInitialDistance = 0;

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
            canvas.style.cursor = isOverYAxis(clientX) ? 'ns-resize' : 'crosshair';
        };

        canvas.addEventListener('mousemove', (e) => {
            if (!isDragging) updateCursor(e.clientX);
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

                if (onZoomChange) onZoomChange(newXMin, newXMax);
            }
        };

        const handleEnd = () => {
            if (isDragging) {
                isDragging = false;
                isYScaleDrag = false;
                document.body.style.cursor = 'default';
            }
        };

        const handleWheel = (e) => {
            e.preventDefault();
            const chart = chartGetter();
            if (!chart) return;

            const zoomFactor = e.deltaY < 0 ? 0.9 : 1.1;

            if (isOverYAxis(e.clientX)) {
                const currentMin = chart.scales.y.min;
                const currentMax = chart.scales.y.max;
                const range = currentMax - currentMin;
                const center = (currentMin + currentMax) / 2;
                const newHalfRange = (range * zoomFactor) / 2;
                chart.options.scales.y.min = Math.max(0, center - newHalfRange);
                chart.options.scales.y.max = center + newHalfRange;
                chart.update('none');
            } else {
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

                if (onZoomChange) onZoomChange(newMin, newMax);
            }
        };

        canvas.addEventListener('mousedown', handleStart);
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleEnd);
        canvas.addEventListener('wheel', handleWheel, { passive: false });

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches && e.touches.length === 1) {
                handleStart(e);
            } else if (e.touches && e.touches.length === 2) {
                isDragging = false;
                const chart = chartGetter();
                if (!chart) return;
                touchPinchInitialDistance = getTouchDistance(e);
            }
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (e.touches && e.touches.length === 1 && isDragging) {
                handleMove(e);
            } else if (e.touches && e.touches.length === 2) {
                const chart = chartGetter();
                if (!chart || touchPinchInitialDistance <= 0) return;

                const currentDistance = getTouchDistance(e);
                const scaleRatio = touchPinchInitialDistance / currentDistance;

                const currentRange = chart.scales.x.max - chart.scales.x.min;
                const centerTime = (chart.scales.x.min + chart.scales.x.max) / 2;
                const newHalfRange = (currentRange * scaleRatio) / 2;

                const newMin = centerTime - newHalfRange;
                const newMax = centerTime + newHalfRange;

                chart.options.scales.x.min = newMin;
                chart.options.scales.x.max = newMax;
                chart.update('none');

                if (onZoomChange) onZoomChange(newMin, newMax);
            }
        }, { passive: true });

        window.addEventListener('touchend', (e) => {
            if (e.touches && e.touches.length < 2) touchPinchInitialDistance = 0;
            handleEnd();
        });
    }

    function syncAssetSubZoom(min, max) {
        if (assetSubChartInstance && assetSubChartInstance.scales.x) {
            assetSubChartInstance.options.scales.x.min = min;
            assetSubChartInstance.options.scales.x.max = max;
            assetSubChartInstance.update('none');
        }
    }

    function syncAssetMainZoom(min, max) {
        if (assetMainChartInstance && assetMainChartInstance.scales.x) {
            assetMainChartInstance.options.scales.x.min = min;
            assetMainChartInstance.options.scales.x.max = max;
            assetMainChartInstance.update('none');
        }
    }

    /* ---- Main Panel: Price + Moving Averages ---- */
    function renderAssetMainChart(data) {
        const ctx = document.getElementById('assetMainCanvas').getContext('2d');
        if (assetMainChartInstance) assetMainChartInstance.destroy();

        const minTimestamp = data[0].x;
        const maxTimestamp = data[data.length - 1].x;

        assetMainChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    { label: 'Adj Close', data: data.map(d => ({ x: d.x, y: d.adj_close })), borderColor: '#4338ca', borderWidth: 2, pointRadius: 0 },
                    { label: 'MA20', data: data.map(d => ({ x: d.x, y: d.ma20 })), borderColor: '#f59e0b', borderWidth: 1.2, pointRadius: 0 },
                    { label: 'MA50', data: data.map(d => ({ x: d.x, y: d.ma50 })), borderColor: '#8b5cf6', borderWidth: 1.2, pointRadius: 0 },
                    { label: 'MA200', data: data.map(d => ({ x: d.x, y: d.ma200 })), borderColor: '#0ea5e9', borderWidth: 1.2, pointRadius: 0 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                layout: { padding: { left: 10, right: 0, top: 0, bottom: 0 } },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                    brandWatermark: { enabled: true }
                },
                scales: {
                    x: {
                        type: 'time',
                        min: minTimestamp,
                        max: maxTimestamp,
                        ticks: { color: 'transparent', font: { size: 9 }, maxRotation: 0, autoSkip: true },
                        grid: { display: true, color: '#f1f5f9' },
                        afterFit: (axis) => { axis.height = 0; }
                    },
                    y: {
                        position: 'right',
                        grid: { display: true, color: '#f1f5f9' },
                        ticks: { font: { size: 9 }, padding: 4 },
                        afterFit: (axis) => { axis.width = 55; }
                    }
                }
            }
        });

        isMAVisible.forEach((visible, idx) => {
            assetMainChartInstance.setDatasetVisibility(idx, visible);
        });
        assetMainChartInstance.update('none');

        attachChartDragInteractions('assetMainCanvas', () => assetMainChartInstance, (min, max) => {
            syncAssetSubZoom(min, max);
        });
    }

    window.toggleMA = function(index) {
        if (!assetMainChartInstance) return;
        const isVisible = assetMainChartInstance.isDatasetVisible(index);
        if (isVisible) {
            assetMainChartInstance.hide(index);
            isMAVisible[index] = false;
        } else {
            assetMainChartInstance.show(index);
            isMAVisible[index] = true;
        }
    };

    /* ---- Sub Panel: Premium / Exposures / Alpha / Volume ---- */
    function buildSubDatasets(data, tab) {
        if (tab === 'exposures') {
            return [
                { label: '\u03B2 SC', data: data.map(d => ({ x: d.x, y: d.beta_sc })), borderColor: '#dc2626', borderWidth: 1.2, pointRadius: 0 },
                { label: '\u03B2 AH', data: data.map(d => ({ x: d.x, y: d.beta_ah })), borderColor: '#06b6d4', borderWidth: 1.2, pointRadius: 0 },
                { label: '\u03B2 H', data: data.map(d => ({ x: d.x, y: d.beta_h })), borderColor: '#ea580c', borderWidth: 1.2, pointRadius: 0 },
                { label: '\u03B2 F', data: data.map(d => ({ x: d.x, y: d.beta_f })), borderColor: '#64748b', borderWidth: 1.2, pointRadius: 0 }
            ];
        }
        if (tab === 'alpha') {
            return [
                { label: '\u03B1 Alpha', data: data.map(d => ({ x: d.x, y: d.alpha })), borderColor: '#2563eb', borderWidth: 1.2, pointRadius: 0, fill: true, backgroundColor: 'rgba(37, 99, 235, 0.06)' }
            ];
        }
        if (tab === 'volume') {
            return [
                { type: 'bar', label: 'Volume', data: data.map(d => ({ x: d.x, y: d.volume })), backgroundColor: 'rgba(148, 163, 184, 0.55)', borderWidth: 0, barPercentage: 1.0, categoryPercentage: 1.0 }
            ];
        }
        return [
            { label: 'Narrative Premium', data: data.map(d => ({ x: d.x, y: d.narrative_premium })), borderColor: '#059669', borderWidth: 1.2, pointRadius: 0, fill: true, backgroundColor: 'rgba(5, 150, 105, 0.06)' }
        ];
    }

    function thresholdsForTab(tab) {
        if (tab === 'volume') return [];
        if (tab === 'premium') return [-1, 0, 1];
        return [0];
    }

    function renderSubTabLegend(tab) {
        const legendEl = document.getElementById('subTabLegend');
        if (!legendEl) return;
        if (tab === 'exposures') {
            legendEl.innerHTML = `
                <span class="check-label" title="${NARRATIVE_FACTOR_NAMES.SC}"><span class="color-dot dot-sc"></span>SC</span>
                <span class="check-label" title="${NARRATIVE_FACTOR_NAMES.AH}"><span class="color-dot dot-ah"></span>AH</span>
                <span class="check-label" title="${NARRATIVE_FACTOR_NAMES.H}"><span class="color-dot dot-h"></span>H</span>
                <span class="check-label" title="${NARRATIVE_FACTOR_NAMES.F}"><span class="color-dot dot-f"></span>F</span>
            `;
        } else if (tab === 'premium') {
            legendEl.innerHTML = `<span class="check-label" title="Z-score normalized (mean 0, std 1)">&plusmn;1&sigma; band</span>`;
        } else {
            legendEl.innerHTML = '';
        }
    }

    function renderAssetSubChart(data, tab) {
        const ctx = document.getElementById('assetSubCanvas').getContext('2d');
        if (assetSubChartInstance) assetSubChartInstance.destroy();

        renderSubTabLegend(tab);

        let currentMin = data[0].x;
        let currentMax = data[data.length - 1].x;

        if (assetMainChartInstance && assetMainChartInstance.scales.x) {
            currentMin = assetMainChartInstance.scales.x.min;
            currentMax = assetMainChartInstance.scales.x.max;
        }

        const baseType = tab === 'volume' ? 'bar' : 'line';

        assetSubChartInstance = new Chart(ctx, {
            type: baseType,
            data: { datasets: buildSubDatasets(data, tab) },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                layout: { padding: { left: 10, right: 0, top: 0, bottom: 0 } },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false },
                    thresholdLines: { lines: thresholdsForTab(tab) }
                },
                scales: {
                    x: {
                        type: 'time',
                        min: currentMin,
                        max: currentMax,
                        ticks: { font: { size: 9 }, maxRotation: 0, autoSkip: true },
                        grid: { display: true, color: '#f1f5f9' }
                    },
                    y: {
                        position: 'right',
                        beginAtZero: tab === 'volume',
                        grid: { display: true, color: '#f1f5f9' },
                        ticks: {
                            font: { size: 8 },
                            callback: tab === 'volume' ? (val) => compactVolumeFormatter.format(val) : undefined
                        },
                        afterFit: (axis) => { axis.width = 55; }
                    }
                }
            }
        });

        attachChartDragInteractions('assetSubCanvas', () => assetSubChartInstance, (min, max) => {
            syncAssetMainZoom(min, max);
        });
    }

    window.setAssetSubTab = function(tab, btnElem) {
        currentSubTab = tab;
        document.querySelectorAll('.btn-tab').forEach(b => b.classList.remove('active'));
        if (btnElem) btnElem.classList.add('active');
        if (assetRawSeries.length) renderAssetSubChart(assetRawSeries, tab);
    };

    /* ---- Unified Range / Zoom Controls ---- */
    window.resetAssetChartZoom = function() {
        if (!assetRawSeries.length) return;
        filterAssetRange('ALL', document.querySelector('.range-selector .btn-range:last-child'));
    };

    /* Aliasing time range selector to existing TradingView MA scale logic */
    window.setAssetTimeRange = function(range, btnElem) {
        filterAssetRange(range, btnElem);
    };

    if (document.readyState === 'loading') {
        document.addEventListener("DOMContentLoaded", initScreener);
    } else {
        initScreener();
    }
})();

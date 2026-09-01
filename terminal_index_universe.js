(function() {
    const API_URL = "https://bizneys.com/api/v1/index-universe?_t=" + new Date().getTime();

    let rawUniverseData = [];
    let filteredUniverseData = [];
    let gridApi = null;

    // Helper function to dynamically retrieve JWT Token from WP global variable or LocalStorage
    function getAuthToken() {
        if (typeof window.bizneysToken !== 'undefined' && window.bizneysToken) {
            return window.bizneysToken;
        }
        return localStorage.getItem('jwt_token') || localStorage.getItem('token') || '';
    }

    function checkDependenciesAndInit() {
        if (typeof agGrid !== 'undefined' && document.getElementById('indexUniverseGrid')) {
            fetchUniverseData();
        } else {
            setTimeout(checkDependenciesAndInit, 100);
        }
    }

    function fetchUniverseData() {
        const token = getAuthToken();
        const headers = {
            'Accept': 'application/json'
        };

        // Attach Authorization header if JWT token exists
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }

        fetch(API_URL, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-cache',
            headers: headers
        })
        .then(res => {
            if (res.status === 401) {
                throw new Error("UNAUTHORIZED");
            }
            if (res.status === 403) {
                throw new Error("FORBIDDEN");
            }
            if (!res.ok) {
                throw new Error("HTTP_ERROR_" + res.status);
            }
            return res.json();
        })
        .then(data => {
            if (!data || !Array.isArray(data) || data.length === 0) {
                console.warn("API returned empty array or invalid format.");
                return;
            }

            // Deduplicate items by Ticker + Target Quarter to fix exact count issue (100)
            const seenKeys = new Set();
            rawUniverseData = data.filter(item => {
                if (!item || (!item.ticker && !item.name)) return false;
                
                const uniqueKey = (item.ticker || item.name) + "_" + (item.target_quarter || "");
                if (seenKeys.has(uniqueKey)) {
                    return false;
                }
                seenKeys.add(uniqueKey);
                return true;
            });

            renderUniverseGrid(rawUniverseData);
            populateQuarterDropdown(rawUniverseData);
        })
        .catch(err => {
            console.error("Error loading Index Universe data:", err);
            const gridDiv = document.getElementById('indexUniverseGrid');
            if (!gridDiv) return;

            // Handle 401/403 and general errors with styled notification UI
            if (err.message === "UNAUTHORIZED") {
                gridDiv.innerHTML = `
                    <div style="padding:40px 20px; text-align:center; color:#e11d48; font-size:14px; font-weight:600; line-height:1.6;">
                        🔒 Authentication required.<br>
                        <span style="font-size:12px; font-weight:400; color:#6b7280;">Please log in to your BIZNEYS account to access this data.</span>
                    </div>`;
            } else if (err.message === "FORBIDDEN") {
                gridDiv.innerHTML = `
                    <div style="padding:40px 20px; text-align:center; color:#d97706; font-size:14px; font-weight:600; line-height:1.6;">
                        ⭐ Pro Membership Required.<br>
                        <span style="font-size:12px; font-weight:400; color:#6b7280;">Access denied. This endpoint is restricted to active Pro members.</span>
                    </div>`;
            } else {
                gridDiv.innerHTML = `
                    <div style="padding:20px; color:#ef4444; font-size:12px; text-align:center;">
                        Failed to load data. Please verify network or CORS configuration.
                    </div>`;
            }
        });
    }

    function populateQuarterDropdown(data) {
        const quarterSelect = document.getElementById("filter-quarter");
        if (!quarterSelect) return;

        const quarters = [...new Set(data.map(d => d.target_quarter).filter(Boolean))].sort().reverse();

        quarterSelect.innerHTML = '<option value="ALL">All Target Quarters</option>';
        quarters.forEach(q => {
            const opt = document.createElement("option");
            opt.value = q;
            opt.innerText = q;
            quarterSelect.appendChild(opt);
        });

        if (quarters.length > 0) {
            quarterSelect.value = quarters[0];
        }

        applyFilters();
    }

    function updateKPICards(data) {
        const totalElem = document.getElementById("kpi-total-count");
        const quarterInfoElem = document.getElementById("kpi-quarter-info");
        const maxWeightElem = document.getElementById("kpi-max-weight");
        const maxTickerElem = document.getElementById("kpi-max-ticker");
        const factorCountElem = document.getElementById("kpi-factor-count");
        const avgAdtvElem = document.getElementById("kpi-avg-adtv");

        if (!data || data.length === 0) {
            if (totalElem) totalElem.innerText = "0";
            if (quarterInfoElem) quarterInfoElem.innerText = "-";
            if (maxWeightElem) maxWeightElem.innerText = "-";
            if (maxTickerElem) maxTickerElem.innerText = "-";
            if (factorCountElem) factorCountElem.innerText = "0";
            if (avgAdtvElem) avgAdtvElem.innerText = "-";
            return;
        }

        if (totalElem) totalElem.innerText = data.length.toLocaleString();

        const quarterSelect = document.getElementById("filter-quarter");
        const selectedQuarter = quarterSelect ? quarterSelect.value : "ALL";
        if (quarterInfoElem) quarterInfoElem.innerText = selectedQuarter !== "ALL" ? selectedQuarter : "Multi-Quarter";

        const sampleHolding = data[0];
        if (maxWeightElem && sampleHolding) {
            maxWeightElem.innerText = sampleHolding.weight !== undefined && sampleHolding.weight !== null ? (sampleHolding.weight * 100).toFixed(2) + "%" : "-";
            if (maxTickerElem) maxTickerElem.innerText = "Equal Weight";
        }

        const uniqueFactors = new Set(data.map(d => d.narrative_factor).filter(Boolean));
        if (factorCountElem) factorCountElem.innerText = uniqueFactors.size;

        const validAdtv = data.map(d => d.rebalance_adtv_63).filter(v => v !== null && v !== undefined);
        if (avgAdtvElem && validAdtv.length > 0) {
            const avg = validAdtv.reduce((a, b) => a + b, 0) / validAdtv.length;
            avgAdtvElem.innerText = formatNumberCompact(avg);
        }
    }

    function formatNumberCompact(num) {
        if (num >= 1e9) return (num / 1e9).toFixed(1) + "B";
        if (num >= 1e6) return (num / 1e6).toFixed(1) + "M";
        if (num >= 1e3) return (num / 1e3).toFixed(1) + "K";
        return num.toFixed(0);
    }

    window.applyFilters = function() {
        if (!rawUniverseData.length) return;

        const searchElem = document.getElementById("search-keyword");
        const factorElem = document.getElementById("filter-factor");
        const quarterElem = document.getElementById("filter-quarter");
        const rankElem = document.getElementById("filter-rank");

        const keyword = searchElem ? searchElem.value.toLowerCase().trim() : "";
        const selectedFactor = factorElem ? factorElem.value : "ALL";
        const selectedQuarter = quarterElem ? quarterElem.value : "ALL";
        const selectedRank = rankElem ? rankElem.value : "ALL";

        filteredUniverseData = rawUniverseData.filter(item => {
            const matchesText = !keyword ||
                (item.ticker && item.ticker.toLowerCase().includes(keyword)) ||
                (item.name && item.name.toLowerCase().includes(keyword));

            const matchesFactor = selectedFactor === "ALL" || item.narrative_factor === selectedFactor;
            const matchesQuarter = selectedQuarter === "ALL" || item.target_quarter === selectedQuarter;
            const matchesRank = selectedRank === "ALL" || (item.adtv_rank && item.adtv_rank <= parseInt(selectedRank));

            return matchesText && matchesFactor && matchesQuarter && matchesRank;
        });

        if (gridApi) {
            if (typeof gridApi.setGridOption === 'function') {
                gridApi.setGridOption('rowData', filteredUniverseData);
            } else if (typeof gridApi.setRowData === 'function') {
                gridApi.setRowData(filteredUniverseData);
            }
            setTimeout(() => gridApi.sizeColumnsToFit(), 50);
        }

        updateKPICards(filteredUniverseData);
    };

    function renderUniverseGrid(initialData) {
        const gridOptions = {
            columnDefs: [
                { field: "target_quarter", headerName: "Target Qtr", sort: "desc", flex: 1, minWidth: 100 },
                {
                    field: "narrative_factor",
                    headerName: "Factor",
                    flex: 1,
                    minWidth: 90,
                    cellRenderer: params => {
                        if (!params.value) return "";
                        const val = params.value.toUpperCase();
                        let badgeClass = "badge-f";
                        if (val === "SC") badgeClass = "badge-sc";
                        else if (val === "AH") badgeClass = "badge-ah";
                        else if (val === "H") badgeClass = "badge-h";
                        return '<span class="badge-factor ' + badgeClass + '">' + val + '</span>';
                    }
                },
                { field: "ticker", headerName: "Ticker", flex: 1, minWidth: 90, cellStyle: { fontWeight: '600', color: '#4338ca' } },
                { field: "name", headerName: "Company Name", flex: 3, minWidth: 200 },
                {
                    field: "weight",
                    headerName: "Weight",
                    valueFormatter: p => p.value !== null && p.value !== undefined ? (p.value * 100).toFixed(2) + "%" : "-",
                    flex: 1.2,
                    minWidth: 100,
                    type: "numericColumn"
                },
                { field: "adtv_rank", headerName: "ADTV Rank", flex: 1.2, minWidth: 100, type: "numericColumn" },
                {
                    field: "rebalance_adtv_63",
                    headerName: "ADTV 63D",
                    valueFormatter: p => p.value ? formatNumberCompact(p.value) : "-",
                    flex: 1.5,
                    minWidth: 120,
                    type: "numericColumn"
                }
            ],
            rowData: initialData,
            pagination: true,
            paginationPageSize: 100,
            suppressHorizontalScroll: true,
            suppressCellFocus: true,
            suppressRowClickSelection: true,
            defaultColDef: { resizable: true, sortable: true, filter: true, suppressDragLeaveHidesColumns: true, suppressMovable: true},
            onGridReady: (params) => {
                gridApi = params.api;
                gridApi.sizeColumnsToFit();
            },
            onGridSizeChanged: (params) => {
                if (params.api) params.api.sizeColumnsToFit();
            }
        };

        const gridDiv = document.getElementById('indexUniverseGrid');
        if (!gridDiv) return;
        gridDiv.innerHTML = '';
        gridApi = agGrid.createGrid(gridDiv, gridOptions);
    }

    window.exportUniverseCSV = function() {
        if (gridApi) gridApi.exportDataAsCsv({ fileName: 'bizneys_index_universe.csv' });
    };

    if (document.readyState === 'loading') {
        document.addEventListener("DOMContentLoaded", checkDependenciesAndInit);
    } else {
        checkDependenciesAndInit();
    }
})();

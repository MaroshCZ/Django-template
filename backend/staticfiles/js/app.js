/*
Project: Najmovac
File: static/js/app.js
Description: Frontend logic for fetching, filtering, and displaying offers on a map.
Author: Jan Alexandr Kopřiva jan.alexandr.kopriva@gmail.com
License: MIT
*/
class PragueRentalApp {
    constructor() {
        this.map = null;
        this.markers = [];
        this.offerMarkers = [];
        this.markerCluster = null;
        this.currentOffers = [];
        this.districts = {};
        this.selectedDistrict = null;
        this.currentDistrictIndex = 0;
        this.pagination = {
            page: 1,
            limit: 500, // Max 500 nabídek na stránku
            total_count: 0,
            total_pages: 0,
            has_next: false,
            has_prev: false
        };
        this.allOffersForMap = []; // Všechny nabídky pro mapu (neomezeno)
        this.loadingMoreOffers = false; // Flag pro kontrolu, zda se právě načítají další nabídky
        this.displayedOffersCount = 0; // Počet aktuálně zobrazených nabídek v seznamu
        this.offersPerPage = 50; // Počet nabídek na jednu "stránku" infinite scrollu
        this.filteredOffersCache = []; // Cache filtrovaných nabídek pro infinite scroll
        this.currentMapBounds = null;
        this.geocodeCache = new Map(); // Cache pro geokódování
        this.lastGeocodeTime = null; // Rate limiting pro LocationIQ
        this.geocodeQueue = []; // Fronta pro geokódování
        this.processingQueue = false; // Flag pro zpracování fronty
        this.lastStatus = '';
        
        // Kontrola statusu
        this.statusCheckInProgress = false; // Flag pro kontrolu, zda už běží kontrola statusu
        this.statusCheckInterval = null; // Interval pro kontrolu statusu
        
        // Pingování nabídek - optimalizované pro viditelné nabídky
        this.pingInProgress = false;
        this.pingedLinks = new Set(); // Set pro sledování již pingovaných linků
        this.pingQueue = []; // Fronta nabídek k pingování
        this.pingDebounceTimer = null; // Debounce timer
        this.initialLoadDone = false; // Flag pro kontrolu, zda už byly nabídky načteny
        this.lastNotificationTime = 0; // Poslední čas zobrazení notifikace pro throttling
        this.lastNotificationMessage = ''; // Poslední zobrazená zpráva pro deduplikaci
        this.notificationQueue = []; // Fronta pro notifikace
        this.notificationShowing = false; // Flag, zda se právě zobrazuje notifikace
        
        // Scrapování nabídek
        this.scrapingInProgress = false;
        this.lastOfferCount = 0; // Počet nabídek při poslední kontrole
        this.scrapingStartedAfterPing = false; // Flag pro kontrolu, zda už bylo scrapování spuštěno po pingování
        this.lastKnownOfferCount = 0; // Počet nabídek při poslední kontrole
        this.lastKnownUpdateTime = null; // Čas poslední aktualizace při poslední kontrole
        this.userStartChoice = null; // Volba uživatele při startu
        
        // Stav interakce uživatele s mapou (abychom neauto-zoomovali)
        this.userInteractedWithMap = false;
        
        // SSE stream
        this.eventSource = null;
        
        this.init();
    }

    async init() {
        await this.loadDistricts();
        await this.loadSettings();
        this.initMap();
        this.setupEventListeners();
        
        // Aktualizovat zobrazení aktivních filtrů při inicializaci
        this.updateActiveFilters();
        
        // Připojit SSE stream pro live updaty
        this.connectSSE();
        
        // Načíst všechny nabídky pro mapu na pozadí
        this.loadAllOffersForMap();
        
        // Načíst nabídky ihned - zobrazí se na mapě ty, které mají souřadnice
        await this.loadOffers(null, { noScrape: true, noPing: true });
        
        // Zkontrolovat volbu uživatele z terminálu před automatickým scrapováním
        try {
            const statusResponse = await fetch('/api/status');
            const statusData = await statusResponse.json();
            this.userStartChoice = statusData.user_start_choice; // Uložit volbu
            
            // Pokud uživatel zvolil "1" (Rychlý start), nespouštět scrapování automaticky
            if (this.userStartChoice === "1") {
                console.log('Rychlý start aktivován - automatické scrapování přeskočeno');
                this.scrapingStartedAfterPing = false; 
            } else if (!this.scrapingInProgress) {
                // Jinak spustit scrapování (volba 2 nebo žádná volba)
                this.startScrapingAfterPing();
            }
        } catch (e) {
            // Fallback při chybě
            if (!this.scrapingInProgress) {
                this.startScrapingAfterPing();
            }
        }
        
        // Spustit periodickou kontrolu změn
        setTimeout(() => {
            this.checkStatus();
        }, 10000); // První kontrola po 10 sekundách
    }
    
    connectSSE() {
        if (this.eventSource) {
            this.eventSource.close();
        }
        
        this.eventSource = new EventSource('/api/stream');
        
        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleSSEMessage(data);
            } catch (e) {
                // Ignorovat parsovací chyby
            }
        };
        
        this.eventSource.onerror = () => {
            // Reconnect po 5 sekundách
            setTimeout(() => this.connectSSE(), 5000);
        };
    }
    
    handleSSEMessage(data) {
        const { message, type, data: eventData } = data;
        
        // Ignorovat connection message
        if (type === 'connected') {
            return;
        }
        
        // Aktualizovat live status bar
        this.updateLiveStatus(message, type, eventData);
        
        // Specifické akce podle typu
        switch (type) {
            case 'ping_progress':
                if (eventData.progress >= 100) {
                    this.showNotification('Pingování dokončeno', 'success');
                }
                break;
            case 'scraping_start':
                this.scrapingInProgress = true;
                break;
            case 'scraping_progress':
                // Aktualizovat progress bar
                break;
            case 'scraper_complete':
                // Nový scraper dokončen - rychle refreshnout
                if (eventData.count > 0) {
                    this.loadOffers();
                }
                break;
            case 'scraping_complete':
                this.scrapingInProgress = false;
                this.loadOffers();
                this.showNotification(`Scrapování dokončeno: ${eventData.total || 0} nabídek`, 'success');
                break;
            case 'offers_updated':
            case 'new_offer':
                if (eventData.count || eventData.offer) {
                    this.loadOffers();
                }
                break;
        }
    }
    
    updateLiveStatus(message, type, eventData = {}) {
        // Status bar je skrytý - pouze logujeme do konzole
        console.log(`[Status] ${type}: ${message}`, eventData);
        return;
        
        // Barvy podle typu
        const colors = {
            'connected': { bg: '#1e293b', border: '#22d3ee', icon: '🔗' },
            'ping_progress': { bg: '#1e293b', border: '#a78bfa', icon: '🔄' },
            'scraping_start': { bg: '#1e293b', border: '#fbbf24', icon: '🚀' },
            'scraping_progress': { bg: '#1e293b', border: '#a78bfa', icon: '⚡' },
            'scraper_complete': { bg: '#1e293b', border: '#4ade80', icon: '✓' },
            'scraping_complete': { bg: '#166534', border: '#4ade80', icon: '✅' },
            'offers_updated': { bg: '#1e293b', border: '#22d3ee', icon: '📦' },
            'new_offer': { bg: '#1e293b', border: '#4ade80', icon: '🆕' },
            'info': { bg: '#1e293b', border: '#22d3ee', icon: 'ℹ️' },
            'error': { bg: '#7f1d1d', border: '#f87171', icon: '❌' }
        };
        
        const style = colors[type] || colors['info'];
        
        statusBar.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: ${style.bg};
            color: #e2e8f0;
            padding: 12px 24px;
            border-radius: 12px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            border: 2px solid ${style.border};
            display: flex;
            align-items: center;
            gap: 10px;
            transition: all 0.3s ease;
            max-width: 90vw;
        `;
        
        // Progress bar pro ping a scraping
        let progressHtml = '';
        if ((type === 'ping_progress' || type === 'scraping_progress') && eventData.progress !== undefined) {
            const pct = eventData.progress || 0;
            progressHtml = `
                <div style="width: 120px; height: 6px; background: #334155; border-radius: 3px; overflow: hidden; margin-left: 10px;">
                    <div style="width: ${pct}%; height: 100%; background: linear-gradient(90deg, ${style.border}, #fff); transition: width 0.3s;"></div>
                </div>
                <span style="font-size: 12px; color: ${style.border};">${pct}%</span>
            `;
        } else if (type === 'scraping_progress' && eventData.current && eventData.total) {
            progressHtml = `<span style="font-size: 12px; color: #94a3b8;">(${eventData.current}/${eventData.total})</span>`;
        }
        
        statusBar.innerHTML = `<span style="font-size: 18px;">${style.icon}</span><span>${message}</span>${progressHtml}`;
        statusBar.style.display = 'flex';
        
        // Schovat po určité době
        const hideDelay = type.includes('complete') ? 5000 : (type.includes('progress') ? 0 : 8000);
        if (hideDelay > 0) {
            clearTimeout(this._statusTimeout);
            this._statusTimeout = setTimeout(() => {
                if (statusBar) statusBar.style.opacity = '0';
                setTimeout(() => {
                    if (statusBar) statusBar.style.display = 'none';
                    statusBar.style.opacity = '1';
                }, 300);
            }, hideDelay);
        }
    }

    async loadSettings() {
        try {
            const res = await fetch('/api/settings');
            // Nastavení se načítá, ale AI funkce nejsou implementovány
        } catch (_) {
            // Chyba při načítání nastavení - tichá
        }
    }

    async loadDistricts() {
        try {
            const response = await fetch('/api/districts');
            this.districts = await response.json();
        } catch (error) {
            // Chyba při načítání městských částí - tichá
        }
    }

    initMap() {
        // Inicializace mapy se středem na Praze
        this.map = L.map('map').setView([50.0755, 14.4378], 11);

        // Přidání OpenStreetMap vrstvy
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);

        // Cluster vrstva pro nabídky
        this.markerCluster = L.markerClusterGroup({
            disableClusteringAtZoom: 16,
            maxClusterRadius: 50,
            showCoverageOnHover: false,
        });
        this.map.addLayer(this.markerCluster);

        // Přidání markerů pro městské části (zatím nevyužito, zachováno)
        this.addDistrictMarkers();

        // Detekce uživatelské interakce s mapou (posun/zoom)
        this.map.on('movestart zoomstart', () => {
            this.userInteractedWithMap = true;
        });

        // Aktualizace nabídek při změně pozice mapy
        this.map.on('moveend zoomend', () => {
            this.updateOffersForCurrentView();
            this.updateMapBounds();
        });

    }

    updateOffersForCurrentView() {
        if (!this.map || !this.allOffersForMap || this.allOffersForMap.length === 0) {
            return;
        }

        const bounds = this.map.getBounds();
        
        // Filtrovat všechny nabídky podle aktuálně nastavených FILTRŮ (dispozice, cena, atd.)
        const filteredAllOffers = this.filterOffers(this.filterPingedOffers(this.allOffersForMap));
        
        // Pak vybrat jen ty, které jsou ve viditelném výřezu mapy
        const visibleOffers = filteredAllOffers.filter(offer => {
            const lat = Number(offer.lat);
            const lng = Number(offer.lng);
            if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) return false;
            return bounds.contains([lat, lng]);
        });

        // Pokud uživatel interagoval s mapou (zoom/pan), aktualizujeme seznam
        if (this.userInteractedWithMap) {
            console.log(`Zoom/Pan: Zobrazeno ${visibleOffers.length} nabídek ve výřezu z celkem ${filteredAllOffers.length} filtrovaných`);
            // Seřadit viditelné nabídky podle aktuálního řazení
            this.currentOffers = this.sortOffers(visibleOffers);
            
            // Renderovat pouze seznam (sidebar), abychom neproblikávali celou mapu
            this.renderSidebarOnly();
            
            // Aktualizovat titulek panelu
            const panelTitle = document.getElementById('panel-title');
            if (panelTitle) {
                panelTitle.textContent = `Nabídky ve viditelné oblasti`;
            }
        }
    }

    renderSidebarOnly(skipPing = false) {
        const container = document.getElementById('offers-list');
        if (!container) return;

        if (this.currentOffers.length === 0) {
            container.innerHTML = `
                <div class="empty-state" role="status">
                    <h3>V této oblasti nejsou žádné nabídky</h3>
                    <p>Zkuste posunout mapu nebo změnit filtry.</p>
                </div>
            `;
            this.updateActiveCount(0, 0);
            return;
        }

        // Pro zobrazení v seznamu použijeme stejnou logiku jako renderOffers
        // ale bez volání displayOffersOnMap()
        
        // Uložit do cache pro infinite scroll
        this.filteredOffersCache = this.currentOffers;
        this.displayedOffersCount = 0;
        
        // Zobrazit první dávku nabídek
        const displayedOffers = this.currentOffers.slice(0, this.offersPerPage);
        this.displayedOffersCount = displayedOffers.length;
        
        container.innerHTML = `
            <div class="offers-grid">
                ${displayedOffers.map((offer, index) => this.createOfferCardHtml(offer, index)).join('')}
            </div>
        `;

        // Aktualizovat počet zobrazených nabídek
        this.updateActiveCount(this.filteredOffersCache.length, this.displayedOffersCount);
        
        // Pingovat viditelné nabídky
        if (!skipPing) {
            this.pingVisibleOffers(displayedOffers);
        }
    }

    createOfferCardHtml(offer, index) {
        return `
            <div class="offer-card" data-offer-index="${index}" onclick="window.pragueApp.showOfferModal(${index})">
                <div class="offer-card-image">
                    ${offer.image_url ? 
                        `<img src="${offer.image_url}" alt="${this.escapeHtml(offer.title)}" loading="lazy">` : 
                        `<div class="placeholder">Obrázek není k dispozici</div>`
                    }
                </div>
                <div class="offer-card-content">
                    <div class="offer-card-title">${this.escapeHtml(this.formatArea(offer.title))}</div>
                    <div class="offer-card-location">${this.escapeHtml(this.formatArea(offer.location))}</div>
                    <div class="offer-card-price-row">
                        <div class="offer-card-price">${this.formatPrice(offer.price)} Kč/měsíc</div>
                        <div class="offer-card-scraper">${offer.scraper}</div>
                    </div>
                    <div class="offer-card-update-time">
                        Aktualizováno: ${this.formatDateTime(this.getLastUpdateTime(offer))}
                    </div>
                </div>
                <div class="offer-card-footer">
                    <a href="${offer.link}" target="_blank" class="offer-card-link" onclick="event.stopPropagation()">
                        Zobrazit
                    </a>
                    <button class="offer-card-button" onclick="event.stopPropagation(); window.pragueApp.showOfferOnMapFromModal(${index})">
                        Mapa
                    </button>
                </div>
            </div>
        `;
    }

    sortOffers(offers) {
        const sortFilter = document.getElementById('sort-filter');
        if (!sortFilter || !sortFilter.value) {
            return offers;
        }
        
        const sorted = [...offers];
        const sortValue = sortFilter.value;
        
        switch (sortValue) {
            case 'price-asc':
                sorted.sort((a, b) => {
                    const priceA = parseInt(a.price.toString().replace(/\D/g, '')) || 0;
                    const priceB = parseInt(b.price.toString().replace(/\D/g, '')) || 0;
                    return priceA - priceB;
                });
                break;
            case 'price-desc':
                sorted.sort((a, b) => {
                    const priceA = parseInt(a.price.toString().replace(/\D/g, '')) || 0;
                    const priceB = parseInt(b.price.toString().replace(/\D/g, '')) || 0;
                    return priceB - priceA;
                });
                break;
            case 'newest':
                sorted.sort((a, b) => {
                    const timeA = this.getLastUpdateTime(a);
                    const timeB = this.getLastUpdateTime(b);
                    return timeB - timeA;
                });
                break;
            case 'oldest':
                sorted.sort((a, b) => {
                    const timeA = this.getLastUpdateTime(a);
                    const timeB = this.getLastUpdateTime(b);
                    return timeA - timeB;
                });
                break;
        }
        
        return sorted;
    }

    renderOffersForView(offers) {
        const container = document.getElementById('offers-list');
        
        if (offers.length === 0) {
            container.innerHTML = '<div class="loading">Žádné nabídky v této oblasti</div>';
            return;
        }

        // Aplikovat filtry podle ping statusu
        let filteredOffers = this.filterPingedOffers(offers);
        
        // Aplikovat další filtry (dispozice, scraper, cena, atd.)
        filteredOffers = this.filterOffers(filteredOffers);
        
        // Aplikovat řazení
        filteredOffers = this.sortOffers(filteredOffers);
        
        container.innerHTML = `
            <div class="offers-grid">
                ${filteredOffers.map((offer, index) => `
                    <div class="offer-card" data-offer-index="${index}" onclick="window.pragueApp.showOfferModal(${index})">
                        <div class="offer-card-image">
                            ${offer.image_url ? 
                                `<img src="${offer.image_url}" alt="${this.escapeHtml(offer.title)}" loading="lazy">` : 
                                `<div class="placeholder">Obrázek není k dispozici</div>`
                            }
                        </div>
                        <div class="offer-card-content">
                            <div class="offer-card-title">${this.escapeHtml(this.formatArea(offer.title))}</div>
                            <div class="offer-card-location">${this.escapeHtml(this.formatArea(offer.location))}</div>
                            <div class="offer-card-price-row">
                                <div class="offer-card-price">${this.formatPrice(offer.price)} Kč/měsíc</div>
                                <div class="offer-card-scraper">${offer.scraper}</div>
                            </div>
                            <div class="offer-card-update-time">
                                Aktualizováno: ${this.formatDateTime(this.getLastUpdateTime(offer))}
                            </div>
                        </div>
                        <div class="offer-card-footer">
                            <a href="${offer.link}" target="_blank" class="offer-card-link" onclick="event.stopPropagation()">
                                Zobrazit
                            </a>
                            <button class="offer-card-button" onclick="event.stopPropagation(); window.pragueApp.showOfferOnMapFromModal(${index})">
                                Mapa
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        
        // Aktualizovat počet zobrazených nabídek
        this.updateActiveCount(filteredOffers.length);
        
        // Pingovat viditelné nabídky (optimalizované)
        this.pingVisibleOffers(filteredOffers);
    }

    addDistrictMarkers() {
        // Markery městských částí jsou nyní skryté - zobrazujeme pouze nabídky
        // Zachováváme funkčnost pro výběr městské části přes nabídky
        this.updateDistrictMarkers();
    }

    updateDistrictMarkers() {
        // Spočítat nabídky pro každou městskou část
        const districtCounts = {};
        
        // Použít city_part nebo extrahovat z location
        this.currentOffers.forEach(offer => {
            let district = null;
            
            // Prioritizovat city_part pokud existuje
            if (offer.city_part) {
                // Extrahovat "Praha X" z city_part
                const match = offer.city_part.match(/praha\s*(\d{1,2})/i);
                if (match) {
                    district = `Praha ${match[1]}`;
                } else {
                    district = offer.city_part;
                }
            } else if (offer.district) {
                // Extrahovat "Praha X" z district
                const match = offer.district.match(/praha\s*(\d{1,2})/i);
                if (match) {
                    district = `Praha ${match[1]}`;
                } else {
                    district = offer.district;
                }
            } else if (offer.location) {
                // Extrahovat "Praha X" z location
                const match = offer.location.match(/praha\s*(\d{1,2})/i);
                if (match) {
                    district = `Praha ${match[1]}`;
                }
            }
            
            if (district) {
                districtCounts[district] = (districtCounts[district] || 0) + 1;
            }
        });
        
        // Aktualizovat barvy markerů
        this.markers.forEach(marker => {
            const districtName = marker.options.icon.options.html.match(/data-district="([^"]+)"/)?.[1];
            if (districtName) {
                const offerCount = districtCounts[districtName] || 0;
                const markerElement = marker.getElement();
                if (markerElement) {
                    const markerDiv = markerElement.querySelector('.district-marker');
                    if (markerDiv) {
                        // Resetovat třídy
                        markerDiv.className = 'district-marker';
                        
                        // Přidat třídy podle stavu
                        if (offerCount > 0) {
                            markerDiv.classList.add('has-offers');
                        }
                        if (districtName === this.selectedDistrict) {
                            markerDiv.classList.add('selected');
                        }
                        
                        // Aktualizovat text s počtem nabídek
                        const districtNumber = districtName.split(' ')[1] || districtName.charAt(0);
                        markerDiv.textContent = offerCount > 0 ? `${districtNumber} (${offerCount})` : districtNumber;
                    }
                }
            }
        });
    }

    async selectDistrict(districtName) {
        this.selectedDistrict = districtName;
        
        // Aktualizace titulku panelu
        document.getElementById('panel-title').textContent = `Nabídky - ${districtName}`;
        
        // Načtení nabídek pro vybranou městskou část
        await this.loadOffers(districtName);
        
        // Zvýraznění markeru
        this.highlightDistrict(districtName);
    }

    highlightDistrict(districtName) {
        // Aktualizovat markery s novými třídami
        this.updateDistrictMarkers();
        
        // Centrovat mapu na vybranou městskou část
        const districtData = this.districts[districtName];
        if (districtData) {
            // Při explicitní volbě části je změna záměrná – povolíme ji
            this.userInteractedWithMap = true;
            this.map.setView([districtData.lat, districtData.lng], 13);
        }
    }

    async loadOffers(district = null, options = {}) {
        const { noScrape = false, noPing = false, resetPagination = true } = options;
        try {
            // Reset paginace při novém načítání
            if (resetPagination) {
                this.pagination.page = 1;
                this.currentOffers = [];
            }
            
            // Získat aktuální řazení
            const sortFilter = document.getElementById('sort-filter').value;
            const sortParam = sortFilter ? `&sort=${encodeURIComponent(sortFilter)}` : '';
            
            // Načíst všechny nabídky najednou (bez infinite scroll)
            const limit = this.pagination.limit; // 500 nabídek max
            
            const url = district ? 
                `/api/offers?district=${encodeURIComponent(district)}&page=${this.pagination.page}&limit=${limit}${sortParam}` : 
                `/api/offers?page=${this.pagination.page}&limit=${limit}${sortParam}`;
            
            // Show loading indicator
            this.showLoading(true);
            
            // Načítám nabídky z URL s timeoutem
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
            
            const response = await fetch(url, { 
                signal: controller.signal,
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            clearTimeout(timeoutId);
            
            const data = await response.json();
            
            const previousCount = this.currentOffers.length;
            const newCount = data.offers ? data.offers.length : 0;
            
            // Načteno nabídek
            
            // Aktualizovat paginaci
            if (data.pagination) {
                this.pagination = data.pagination;
            }
            
            // Použít active_count z API pokud je k dispozici (počet po filtrování)
            const apiActiveCount = data.active_count || data.pagination?.total_count;
            
            // Načíst všechny nabídky najednou (bez infinite scroll)
            this.currentOffers = data.offers || [];
            
            // Zpracovat informaci o rozšířeném vyhledávání
            if (data.expanded_districts && data.expanded_districts.length > 0) {
                const expandedInfo = `Vyhledávání rozšířeno do okolních částí: ${data.expanded_districts.join(', ')}`;
                this.showNotification(expandedInfo, 'info');
            }
            
            this.renderOffers();
            
            // Aktualizovat počet zobrazených nabídek - použít active_count z API nebo total_count z paginace
            const totalActiveCount = apiActiveCount || this.pagination?.total_count || this.currentOffers.length;
            this.updateActiveCount(totalActiveCount);
            
            // Pingování viditelných nabídek se děje automaticky v renderOffers()
            // Zde pouze spustíme scrapování pokud nejsou žádné nabídky
            // Ale pouze pokud uživatel nezvolil "Rychlý start"
            if (this.currentOffers.length === 0 && !noScrape && this.userStartChoice !== "1") {
                this.startScrapingAfterPing();
            }
            
            // Pokud se počet nabídek zvýšil, zobrazit notifikaci jen při významné změně nebo při manuálním načtení
            // Nezobrazovat během automatického pingování nebo scrapování
            if (newCount > 0 && previousCount > 0 && !this.pingInProgress && !this.scrapingInProgress) {
                // Zobrazit jen pokud je to významná změna (více než 10 nabídek)
                if (newCount > 10) {
                    const timestamp = new Date().toLocaleTimeString('cs-CZ');
                    this.showNotification(`[${timestamp}] Načteno ${newCount} nových nabídek!`);
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                this.showError('Timeout při načítání nabídek', true);
            } else {
                this.showError('Chyba při načítání nabídek', true);
            }
        } finally {
            this.showLoading(false);
        }
    }

    renderOffers() {
        const container = document.getElementById('offers-list');
        // Renderuji nabídky
        
        if (this.currentOffers.length === 0) {
            const districtFilter = document.getElementById('district-filter').value;
            if (districtFilter) {
                container.innerHTML = `
                    <div class="empty-state" role="status">
                        <h3>Žádné nabídky v ${this.escapeHtml(districtFilter)}</h3>
                        <p>Zkuste jinou pražskou část nebo upravte filtry.</p>
                    </div>
                `;
            } else {
                container.innerHTML = `
                    <div class="empty-state" role="status">
                        <h3>Žádné nabídky nenalezeny</h3>
                        <p>Zkuste upravit filtry nebo počkejte na načtení nových nabídek.</p>
                        <button class="btn btn-primary" onclick="window.pragueApp.loadOffers()" aria-label="Zkusit znovu načíst nabídky">
                            Zkusit znovu
                        </button>
                    </div>
                `;
            }
            return;
        }

        // Filtrovat currentOffers pro zobrazení v seznamu
        const filteredCurrentOffers = this.filterOffers(this.filterPingedOffers(this.currentOffers));
        
        // Uložit do cache pro infinite scroll
        this.filteredOffersCache = filteredCurrentOffers;
        this.displayedOffersCount = 0;
        
        // Zobrazit první dávku nabídek
        const displayedOffers = filteredCurrentOffers.slice(0, this.offersPerPage);
        this.displayedOffersCount = displayedOffers.length;
        
        // Vytvořit grid layout - zobrazit filtrované currentOffers
        container.innerHTML = `
            <div class="offers-grid">
                ${displayedOffers.map((offer, index) => this.createOfferCardHtml(offer, index)).join('')}
            </div>
        `;

        // Modal je nyní zpracováván přes onclick v HTML
        
        // Aktualizovat mapu s filtrovanými nabídkami
        this.displayOffersOnMap();
        
        // Aktualizovat počet zobrazených nabídek
        const totalFilteredCount = this.pagination?.total_count || filteredCurrentOffers.length;
        this.updateActiveCount(totalFilteredCount, this.displayedOffersCount);
        
        // Pingovat viditelné nabídky (optimalizované)
        this.pingVisibleOffers(displayedOffers);
    }
    
    updateActiveCount(totalCount, displayedCount = null) {
        const activeCountElement = document.getElementById('active-count');
        if (activeCountElement) {
            // totalCount je celkový počet platných nabídek po filtrování z API
            const total = totalCount || this.pagination?.total_count || 0;
            // displayedCount je počet zobrazených nabídek v seznamu (limit 50)
            const displayed = displayedCount !== null ? displayedCount : (this.currentOffers.length || 0);
            
            // Pokud máme paginaci a celkový počet je větší než zobrazený, zobrazit "X z Y"
            if (total > displayed && displayed > 0) {
                activeCountElement.textContent = `${displayed.toLocaleString('cs-CZ')} z ${total.toLocaleString('cs-CZ')}`;
            } else if (total > 0) {
                // Jinak zobrazit celkový počet platných nabídek
                activeCountElement.textContent = total.toLocaleString('cs-CZ');
            } else {
                // Pokud není žádný počet, zobrazit zobrazený počet
                activeCountElement.textContent = displayed.toLocaleString('cs-CZ');
            }
        }
        // Aktualizovat také aktivní filtry
        this.updateActiveFilters();
    }

    updateActiveFilters() {
        const activeFiltersContainer = document.getElementById('active-filters');
        if (!activeFiltersContainer) return;

        const filters = [];
        
        // Dispozice
        const dispositionFilter = document.getElementById('disposition-filter');
        if (dispositionFilter && dispositionFilter.value) {
            filters.push({
                label: 'Dispozice',
                value: dispositionFilter.options[dispositionFilter.selectedIndex].text
            });
        }
        
        // Server
        const scraperFilter = document.getElementById('scraper-filter');
        if (scraperFilter && scraperFilter.value) {
            filters.push({
                label: 'Server',
                value: scraperFilter.options[scraperFilter.selectedIndex].text
            });
        }
        
        // Pražská část
        const districtFilter = document.getElementById('district-filter');
        if (districtFilter && districtFilter.value) {
            filters.push({
                label: 'Část',
                value: districtFilter.options[districtFilter.selectedIndex].text
            });
        }
        
        // Cena
        const priceFilter = document.getElementById('price-filter');
        if (priceFilter && priceFilter.value) {
            const priceValue = parseInt(priceFilter.value.replace(/\D/g, ''));
            if (priceValue > 0 && !priceFilter.classList.contains('error')) {
                filters.push({
                    label: 'Max cena',
                    value: `${priceValue.toLocaleString('cs-CZ')} Kč`
                });
            }
        }
        
        // Řazení
        const sortFilter = document.getElementById('sort-filter');
        if (sortFilter && sortFilter.value) {
            const sortText = sortFilter.options[sortFilter.selectedIndex].text;
            if (sortText !== 'Výchozí řazení') {
                filters.push({
                    label: 'Řazení',
                    value: sortText
                });
            }
        }
        
        // Zobrazit filtry pouze pokud jsou nějaké aktivní
        if (filters.length > 0) {
            activeFiltersContainer.innerHTML = filters.map(filter => 
                `<span class="active-filter-tag">
                    <span class="filter-label">${this.escapeHtml(filter.label)}:</span>
                    <span class="filter-value">${this.escapeHtml(filter.value)}</span>
                </span>`
            ).join('');
            activeFiltersContainer.style.display = 'flex';
            
            // Zobrazit tlačítko "Vyčistit filtry"
            const clearFiltersBtn = document.getElementById('clear-filters-btn');
            if (clearFiltersBtn) {
                clearFiltersBtn.style.display = 'flex';
            }
        } else {
            activeFiltersContainer.innerHTML = '';
            activeFiltersContainer.style.display = 'none';
            
            // Skrýt tlačítko "Vyčistit filtry"
            const clearFiltersBtn = document.getElementById('clear-filters-btn');
            if (clearFiltersBtn) {
                clearFiltersBtn.style.display = 'none';
            }
        }
    }

    clearFilters() {
        // Vyčistit všechny filtry
        const dispositionFilter = document.getElementById('disposition-filter');
        const scraperFilter = document.getElementById('scraper-filter');
        const districtFilter = document.getElementById('district-filter');
        const priceFilter = document.getElementById('price-filter');
        const sortFilter = document.getElementById('sort-filter');
        
        if (dispositionFilter) dispositionFilter.value = '';
        if (scraperFilter) scraperFilter.value = '';
        if (districtFilter) districtFilter.value = '';
        if (priceFilter) {
            priceFilter.value = '';
            priceFilter.classList.remove('error');
            const errorElement = document.getElementById('price-filter-error');
            if (errorElement) errorElement.textContent = '';
        }
        if (sortFilter) sortFilter.value = '';
        
        // Resetovat selectedDistrict
        this.selectedDistrict = null;
        document.getElementById('panel-title').textContent = 'Všechny nabídky';
        
        // Aktualizovat aktivní filtry
        this.updateActiveFilters();
        
        // Načíst všechny nabídky bez filtrů
        this.resetPagination();
        this.loadOffers(null, { noScrape: true, noPing: true });
    }
    

    filterOffers(offers = null) {
        let filtered = offers ? [...offers] : [...this.currentOffers];
        
        // Filtr podle dispozice
        const dispositionFilter = document.getElementById('disposition-filter').value;
        if (dispositionFilter) {
            filtered = filtered.filter(offer => {
                const title = (offer.title || '').toLowerCase();
                const location = (offer.location || '').toLowerCase();
                const searchText = title + ' ' + location;
                
                if (dispositionFilter === '1+kk') {
                    return searchText.includes('1+kk') || searchText.includes('1 kk') || searchText.includes('1kk');
                } else if (dispositionFilter === '1+1') {
                    return searchText.includes('1+1') || searchText.includes('1 +1');
                } else if (dispositionFilter === '2+kk') {
                    return searchText.includes('2+kk') || searchText.includes('2 kk') || searchText.includes('2kk');
                } else if (dispositionFilter === '2+1') {
                    return searchText.includes('2+1') || searchText.includes('2 +1');
                } else if (dispositionFilter === '3+kk') {
                    return searchText.includes('3+kk') || searchText.includes('3 kk') || searchText.includes('3kk');
                } else if (dispositionFilter === '3+1') {
                    return searchText.includes('3+1') || searchText.includes('3 +1');
                } else if (dispositionFilter === '4+kk') {
                    return searchText.includes('4+kk') || searchText.includes('4 kk') || searchText.includes('4kk');
                } else if (dispositionFilter === '4+1') {
                    return searchText.includes('4+1') || searchText.includes('4 +1');
                } else if (dispositionFilter === '5++') {
                    return searchText.includes('5+kk') || searchText.includes('5+1') || searchText.includes('6+') || searchText.includes('7+');
                } else if (dispositionFilter === 'others') {
                    return searchText.includes('garsonka') || searchText.includes('atypický') || searchText.includes('atypicky');
                }
                return true;
            });
        }
        
        // Filtr podle scraperu
        const scraperFilter = document.getElementById('scraper-filter').value;
        if (scraperFilter) {
            filtered = filtered.filter(offer => offer.scraper === scraperFilter);
        }
        
        // Filtr podle pražské části
        const districtFilter = document.getElementById('district-filter').value;
        if (districtFilter) {
            filtered = filtered.filter(offer => {
                const cityPart = (offer.city_part || '').toLowerCase();
                const location = (offer.location || '').toLowerCase();
                const title = (offer.title || '').toLowerCase();
                const searchText = location + ' ' + title + ' ' + cityPart;
                
                // Hledat číslo části v lokaci nebo titulu
                const districtNumber = districtFilter.split(' ')[1]; // "Praha 1" -> "1"
                
                // Prioritně zkontrolovat city_part (pokud ho máme z API)
                if (cityPart && (cityPart.includes(`praha ${districtNumber}`) || cityPart === `praha ${districtNumber}`)) {
                    return true;
                }

                // Použít regex pro přesné hledání čísla části (aby "Praha 1" nenašlo "Praha 10")
                const regex = new RegExp(`praha\\s+${districtNumber}\\b|praha\\s*${districtNumber}(?!\\d)|p\\s*${districtNumber}\\b`, 'i');
                return regex.test(searchText);
            });
        }
        
        // Filtr podle ceny
        const priceFilter = document.getElementById('price-filter').value;
        if (priceFilter) {
            const maxPrice = parseInt(priceFilter);
            filtered = filtered.filter(offer => {
                const price = parseInt(offer.price.toString().replace(/\D/g, ''));
                return price <= maxPrice;
            });
        }
        
        // Řazení se nyní provádí na backendu pro lepší výkon
        
        return filtered;
    }
    
    filterPingedOffers(offers = null) {
        let filtered = offers ? [...offers] : [...this.currentOffers];
        
        // Filtr podle ping statusu - zobrazit pouze platné nabídky nebo nepingované
        // Skrýt pouze ty, které mají explicitně last_ping_is_valid === false
        filtered = filtered.filter(offer => {
            // Pokud není last_ping_is_valid nastaveno, nabídka je platná (ještě nepingovaná)
            if (offer.last_ping_is_valid === undefined || offer.last_ping_is_valid === null) {
                return true;
            }
            // Zobrazit pouze pokud je explicitně platná
            return offer.last_ping_is_valid === true;
        });
        
        // Filtr podle ceny - zobrazit pouze nabídky s cenou > 0 a < 1 milion Kč (pronájmy, ne prodeje)
        filtered = filtered.filter(offer => {
            const price = parseInt(offer.price.toString().replace(/\D/g, ''));
            return price > 0 && price < 1000000; // Přeskočit ceny nad 1 milion (pravděpodobně prodeje)
        });
        
        return filtered;
    }

    // Statistiky odstraněny


    async checkStatus() {
        // Zabránit více souběžným kontrolám
        if (this.statusCheckInProgress) {
            return;
        }
        
        this.statusCheckInProgress = true;
        
        try {
            const response = await fetch('/api/status');
            const data = await response.json();
            
            // Aktualizovat indikátor zpracování
            this.updateProcessingIndicator(data.fetching_status);
            
            // Detekovat změny v nabídkách
            const currentOfferCount = data.valid_count || data.cache_count || 0;
            const currentUpdateTime = data.last_update || null;
            
            // Pokud se změnil počet nabídek nebo čas aktualizace, načíst nové nabídky
            const offersChanged = currentOfferCount !== this.lastKnownOfferCount || 
                                 currentUpdateTime !== this.lastKnownUpdateTime;
            
            if (offersChanged && !this.pingInProgress && !this.scrapingInProgress) {
                // Aktualizovat pouze pokud neběží pingování nebo scrapování
                this.lastKnownOfferCount = currentOfferCount;
                this.lastKnownUpdateTime = currentUpdateTime;
                
                // Načíst nové nabídky bez pingování a scrapování
                await this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
            } else {
                // Aktualizovat pouze počítadla
                this.lastKnownOfferCount = currentOfferCount;
                this.lastKnownUpdateTime = currentUpdateTime;
            }
            
            // Pokud se stále načítá nebo zpracovává, zkontrolovat znovu za 3 sekundy
            // Ale ignorovat pingování - má vlastní notifikace
            if (data.fetching_status && 
                !data.fetching_status.includes('Pinguji') &&
                (data.fetching_status.includes('Zpracovávám') || data.fetching_status.includes('Začínám') || data.fetching_status.includes('Auto-zpracováno'))) {
                setTimeout(() => {
                    this.statusCheckInProgress = false;
                    this.checkStatus();
                }, 3000);
            } else {
                // Pokud není aktivní zpracování, kontrolovat každých 10 sekund
                setTimeout(() => {
                    this.statusCheckInProgress = false;
                    this.checkStatus();
                }, 10000);
            }
        } catch (error) {
            // Chyba při kontrole statusu - zkontrolovat, jestli aplikace běží
            if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
                // Aplikace pravděpodobně neběží
                console.warn('Aplikace není dostupná - zkontrolujte, jestli Flask server běží na portu 5001');
                this.showNotification('⚠️ Server není dostupný - zkontrolujte, jestli Flask server běží na portu 5001', 'error');
            }
            // Při chybě zkusit znovu za 5 sekund
            setTimeout(() => {
                this.statusCheckInProgress = false;
                this.checkStatus();
            }, 5000);
        }
    }

    toggleMapExpansion() {
        const mainContent = document.querySelector('.main-content');
        const expandBtn = document.getElementById('expand-map-btn');
        
        if (mainContent.classList.contains('expanded-map')) {
            // Vrátit na normální layout
            mainContent.classList.remove('expanded-map');
            expandBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" fill="currentColor"/>
                </svg>
                Zvětšit mapu
            `;
            expandBtn.title = 'Zvětšit mapu';
        } else {
            // Rozšířit mapu
            mainContent.classList.add('expanded-map');
            expandBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" fill="currentColor"/>
                </svg>
                Zmenšit mapu
            `;
            expandBtn.title = 'Zmenšit mapu';
        }
        
        // Po změně layoutu invalidovat mapu, aby se správně vykreslila
        setTimeout(() => {
            if (this.map) {
                this.map.invalidateSize();
            }
        }, 300);
    }

    setupEventListeners() {
        // Tlačítko aktualizace
        document.getElementById('refresh-btn').addEventListener('click', () => {
            this.userInteractedWithMap = false; // Reset interakce pro auto-zoom
            this.initialLoadDone = false;
            // Obnovit všechna data pro mapu i seznam
            this.loadAllOffersForMap();
            this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
        });

        // Tlačítko zobrazit vše
        document.getElementById('show-all-btn').addEventListener('click', () => {
            this.selectedDistrict = null;
            this.userInteractedWithMap = false; // Reset interakce pro auto-zoom
            this.initialLoadDone = false;
            document.getElementById('panel-title').textContent = 'Všechny nabídky';
            this.loadAllOffersForMap();
            this.loadOffers();
            this.resetMapView();
        });

        // Tlačítko rozšířit mapu
        const expandMapBtn = document.getElementById('expand-map-btn');
        if (expandMapBtn) {
            expandMapBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleMapExpansion();
            });
        } else {
            console.error('Tlačítko expand-map-btn nebylo nalezeno!');
        }

        // Collapse/expand filters
        const filtersToggle = document.getElementById('filters-toggle');
        const filtersContent = document.getElementById('filters-content');
        if (filtersToggle && filtersContent) {
            filtersToggle.addEventListener('click', () => {
                const expanded = filtersToggle.getAttribute('aria-expanded') === 'true';
                if (expanded) {
                    filtersContent.classList.remove('is-expanded');
                    filtersContent.classList.add('is-collapsed');
                    filtersToggle.setAttribute('aria-expanded', 'false');
                    filtersToggle.textContent = 'Zobrazit filtry';
                } else {
                    filtersContent.classList.remove('is-collapsed');
                    filtersContent.classList.add('is-expanded');
                    filtersToggle.setAttribute('aria-expanded', 'true');
                    filtersToggle.textContent = 'Skrýt filtry';
                }
            });
        }

        // Filtry
        document.getElementById('disposition-filter').addEventListener('change', () => {
            this.resetPagination();
            this.updateActiveFilters(); // Aktualizovat zobrazení filtrů
            this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
            // Markery se aktualizují automaticky v renderOffers() -> displayOffersOnMap()
        });

        document.getElementById('scraper-filter').addEventListener('change', () => {
            this.resetPagination();
            this.updateActiveFilters(); // Aktualizovat zobrazení filtrů
            this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
            // Markery se aktualizují automaticky v renderOffers() -> displayOffersOnMap()
        });

        // Validace a debounce pro price filter
        this.setupPriceFilterValidation();
        
        // Keyboard navigation
        this.setupKeyboardNavigation();

        document.getElementById('district-filter').addEventListener('change', () => {
            this.resetPagination();
            const districtValue = document.getElementById('district-filter').value;
            // Pokud je vybrána "Všechny části" (prázdná hodnota), nastavit selectedDistrict na null
            this.selectedDistrict = districtValue || null;
            this.updateActiveFilters(); // Aktualizovat zobrazení filtrů
            // Aktualizovat titul panelu
            if (districtValue) {
                document.getElementById('panel-title').textContent = `Nabídky - ${districtValue}`;
            } else {
                document.getElementById('panel-title').textContent = 'Všechny nabídky';
            }
            this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
        });

        document.getElementById('sort-filter').addEventListener('change', () => {
            this.resetPagination();
            this.updateActiveFilters(); // Aktualizovat zobrazení filtrů
            this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
        });

        // Tlačítko pro vyčištění filtrů
        document.getElementById('clear-filters-btn').addEventListener('click', () => {
            this.clearFilters();
        });

        // Infinite scroll pro seznam nabídek
        const offersContainer = document.getElementById('offers-list');
        if (offersContainer) {
            offersContainer.addEventListener('scroll', () => {
                // Kontrola, zda jsme blízko konce seznamu
                const scrollTop = offersContainer.scrollTop;
                const scrollHeight = offersContainer.scrollHeight;
                const clientHeight = offersContainer.clientHeight;
                
                // Pokud jsme 200px od konce, načíst další nabídky
                if (scrollTop + clientHeight >= scrollHeight - 200) {
                    this.loadMoreOffers();
                }
            });
        }
    }
    
    loadMoreOffers() {
        if (this.loadingMoreOffers) return;
        
        // Zkontrolovat, zda máme další nabídky k zobrazení
        if (this.displayedOffersCount >= this.filteredOffersCache.length) {
            return; // Všechny nabídky jsou již zobrazeny
        }
        
        this.loadingMoreOffers = true;
        
        // Získat další dávku nabídek
        const startIndex = this.displayedOffersCount;
        const endIndex = Math.min(startIndex + this.offersPerPage, this.filteredOffersCache.length);
        const newOffers = this.filteredOffersCache.slice(startIndex, endIndex);
        
        if (newOffers.length === 0) {
            this.loadingMoreOffers = false;
            return;
        }
        
        // Přidat nové karty do gridu
        const container = document.querySelector('#offers-list .offers-grid');
        if (container) {
            const newCardsHtml = newOffers.map((offer, idx) => {
                const index = startIndex + idx;
                return `
                    <div class="offer-card" data-offer-index="${index}" onclick="window.pragueApp.showOfferModal(${index})">
                        <div class="offer-card-image">
                            ${offer.image_url ? 
                                `<img src="${offer.image_url}" alt="${this.escapeHtml(offer.title)}" loading="lazy">` : 
                                `<div class="placeholder">Obrázek není k dispozici</div>`
                            }
                        </div>
                        <div class="offer-card-content">
                            <div class="offer-card-title">${this.escapeHtml(this.formatArea(offer.title))}</div>
                            <div class="offer-card-location">${this.escapeHtml(this.formatArea(offer.location))}</div>
                            <div class="offer-card-price-row">
                                <div class="offer-card-price">${this.formatPrice(offer.price)} Kč/měsíc</div>
                                <div class="offer-card-scraper">${offer.scraper}</div>
                            </div>
                            <div class="offer-card-update-time">
                                Aktualizováno: ${this.formatDateTime(this.getLastUpdateTime(offer))}
                            </div>
                        </div>
                        <div class="offer-card-footer">
                            <a href="${offer.link}" target="_blank" class="offer-card-link" onclick="event.stopPropagation()">
                                Zobrazit
                            </a>
                            <button class="offer-card-button" onclick="event.stopPropagation(); window.pragueApp.showOfferOnMapFromModal(${index})">
                                Mapa
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
            
            container.insertAdjacentHTML('beforeend', newCardsHtml);
            this.displayedOffersCount = endIndex;
            
            // Aktualizovat počet zobrazených nabídek
            this.updateActiveCount(this.filteredOffersCache.length, this.displayedOffersCount);
        }
        
        this.loadingMoreOffers = false;
    }

    updateMapBounds() {
        if (!this.map) return;
        
        const bounds = this.map.getBounds();
        this.currentMapBounds = {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
        };
        
    }


    async showMoreOffersInArea() {
        if (!this.map || !this.currentMapBounds) {
            // Mapa nebo bounds nejsou k dispozici
            return;
        }

        try {
            const response = await fetch('/api/offers-nearby', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    bounds: this.currentMapBounds,
                    limit: 100
                })
            });

            const data = await response.json();
            
            if (data.offers && data.offers.length > 0) {
                // Přidat nové nabídky k existujícím
                this.currentOffers = [...this.currentOffers, ...data.offers];
                
                // Aktualizovat zobrazení
                this.renderOffers();
                this.displayOffersOnMap();
                this.updateActiveCount(this.currentOffers.length);
                
                // Oddálit mapu pro lepší přehled
                this.zoomOutMap();
                
                // Načteno nabídek v okolí
                this.showNotification(`Načteno ${data.offers.length} nabídek v okolí`);
            } else {
                this.showNotification('V okolí nejsou žádné další nabídky');
            }
        } catch (error) {
            // Chyba při načítání nabídek v okolí
            this.showNotification('Chyba při načítání nabídek v okolí');
        }
    }

    zoomOutMap() {
        if (!this.map) return;
        
        const currentZoom = this.map.getZoom();
        const newZoom = Math.max(currentZoom - 2, 10); // Oddálit o 2 úrovně, minimálně zoom 10
        
        this.map.setZoom(newZoom);
        
    }

    resetPagination() {
        this.pagination.page = 1;
        this.currentOffers = [];
        this.loadingMoreOffers = false;
    }

    resetMapView() {
        this.map.setView([50.0755, 14.4378], 11);
        this.markers.forEach(marker => {
            marker.getElement().style.background = '#e74c3c';
        });
    }

    showError(message, recoverable = false) {
        const container = document.getElementById('offers-list');
        container.innerHTML = `
            <div class="error-state" role="alert">
                <div class="error-icon">⚠️</div>
                <h3>Něco se pokazilo</h3>
                <p>${this.escapeHtml(message)}</p>
                ${recoverable ? `
                    <button class="btn btn-primary" onclick="window.pragueApp.retry()" aria-label="Zkusit znovu načíst nabídky">
                        Zkusit znovu
                    </button>
                ` : ''}
            </div>
        `;
    }
    
    retry() {
        this.loadOffers(this.selectedDistrict);
    }
    
    setupPriceFilterValidation() {
        const priceFilter = document.getElementById('price-filter');
        const errorElement = document.getElementById('price-filter-error');
        let priceFilterTimeout;
        
        priceFilter.addEventListener('input', (e) => {
            const value = e.target.value;
            const numValue = parseInt(value.replace(/\D/g, ''));
            
            // Validace
            if (value && (isNaN(numValue) || numValue < 0 || numValue > 1000000)) {
                e.target.setAttribute('aria-invalid', 'true');
                e.target.classList.add('error');
                errorElement.textContent = 'Cena musí být mezi 0 a 1 000 000 Kč';
                errorElement.setAttribute('role', 'alert');
            } else {
                e.target.setAttribute('aria-invalid', 'false');
                e.target.classList.remove('error');
                errorElement.textContent = '';
                
                // Debounce pro aplikování filtru
                clearTimeout(priceFilterTimeout);
                priceFilterTimeout = setTimeout(() => {
                    this.resetPagination();
                    this.updateActiveFilters();
                    this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
                }, 500);
            }
        });
        
        // Validace při blur
        priceFilter.addEventListener('blur', (e) => {
            const value = e.target.value;
            const numValue = parseInt(value.replace(/\D/g, ''));
            
            if (value && (isNaN(numValue) || numValue < 0 || numValue > 1000000)) {
                e.target.setAttribute('aria-invalid', 'true');
                e.target.classList.add('error');
                errorElement.textContent = 'Cena musí být mezi 0 a 1 000 000 Kč';
            }
        });
    }
    
    setupKeyboardNavigation() {
        document.addEventListener('keydown', (e) => {
            // ESC pro zavření modalu
            const modal = document.getElementById('offer-modal');
            if (e.key === 'Escape' && modal && modal.getAttribute('aria-hidden') === 'false') {
                this.closeModal();
            }
            
            // Enter pro aktivaci tlačítek při focus
            if (e.key === 'Enter' && document.activeElement.classList.contains('btn')) {
                document.activeElement.click();
            }
        });
    }
    
    showNotification(message, type = 'default') {
        // Přidat do fronty
        this.notificationQueue.push({ message, type });
        
        // Pokud se právě nezobrazuje žádná notifikace, zobrazit první z fronty
        if (!this.notificationShowing) {
            this.processNotificationQueue();
        }
    }

    processNotificationQueue() {
        if (this.notificationQueue.length === 0) {
            this.notificationShowing = false;
            return;
        }

        this.notificationShowing = true;
        
        // Throttling - neukazovat notifikace častěji než jednou za 3 sekundy
        const now = Date.now();
        const timeSinceLastNotification = now - this.lastNotificationTime;
        const minDelay = 3000; // Minimální prodleva mezi notifikacemi: 3 sekundy
        
        if (timeSinceLastNotification < minDelay) {
            // Počkat, než uplyne minimální prodleva
            setTimeout(() => {
                this.processNotificationQueue();
            }, minDelay - timeSinceLastNotification);
            return;
        }

        // Vzít první notifikaci z fronty
        const { message, type } = this.notificationQueue.shift();
        
        // Kontrola duplicitních zpráv - přeskočit pokud je stejná jako předchozí
        if (message === this.lastNotificationMessage) {
            // Přeskočit duplicitní zprávu a pokračovat s další
            this.processNotificationQueue();
            return;
        }
        
        this.lastNotificationTime = Date.now();
        this.lastNotificationMessage = message;
        
        // Vytvořit notifikační element
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        
        // Nastavit barvy podle typu
        let backgroundColor, textColor;
        switch (type) {
            case 'info':
                backgroundColor = '#3498db';
                textColor = '#ffffff';
                break;
            case 'success':
                backgroundColor = '#27ae60';
                textColor = '#ffffff';
                break;
            case 'warning':
                backgroundColor = '#f39c12';
                textColor = '#ffffff';
                break;
            case 'error':
                backgroundColor = '#e74c3c';
                textColor = '#ffffff';
                break;
            default:
                backgroundColor = 'var(--black)';
                textColor = 'var(--white)';
        }
        
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${backgroundColor};
            color: ${textColor};
            padding: 12px 20px;
            border-radius: 0px;
            font-weight: 600;
            font-size: 0.9rem;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            animation: slideIn 0.3s ease-out;
        `;
        
        // Přidat CSS animaci
        if (!document.getElementById('notification-styles')) {
            const style = document.createElement('style');
            style.id = 'notification-styles';
            style.textContent = `
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }
        
        document.body.appendChild(notification);
        
        // Automaticky odstranit po 5 sekundách (zvýšeno z 3 sekund)
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease-in';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
                // Zobrazit další notifikaci z fronty po skrytí této
                this.processNotificationQueue();
            }, 300);
        }, 5000); // Zvýšeno z 3000 na 5000 ms
    }
    
    updateProcessingIndicator(status) {
        const indicator = document.getElementById('processing-indicator');
        const text = indicator.querySelector('.processing-text');
        
        if (!status) {
            indicator.style.display = 'none';
            return;
        }
        
        // Ignorovat statusy pingování - mají vlastní notifikace
        if (status.includes('Pinguji')) {
            indicator.style.display = 'none';
            return;
        }
        
        // Rozpoznat scrapování konkrétního scraperu
        let displayText = status;
        
        // Parsovat názvy scraperů ze statusu
        const scraperNames = {
            'BAZOS': 'Bazos',
            'Sreality': 'Sreality',
            'BezRealitky': 'Bezrealitky',
            'iDNES Reality': 'iDNES Reality',
            'realingo': 'Realingo',
            'Remax': 'Remax',
            'REALCITY': 'Realcity',
            'Eurobydlení': 'Euro Bydlení',
            'UlovDomov': 'UlovDomov',
            'BRAVIS': 'Bravis'
        };
        
        // Najít scraper ve statusu
        for (const [key, name] of Object.entries(scraperNames)) {
            if (status.includes(key) || status.includes(name)) {
                if (status.includes('Scrapuji') || status.includes('Zpracovávám')) {
                    displayText = `Scrapuji ${name}...`;
                    break;
                }
            }
        }
        
        // Pokud obsahuje klíčová slova pro scrapování, zobrazit loader
        if (status.includes('Scrapuji') || 
            status.includes('Zpracovávám') || 
            status.includes('Začínám aktualizaci') ||
            status.includes('Spouštím scrapování')) {
            indicator.style.display = 'flex';
            if (text) {
                // Zkrátit dlouhé statusy, ale zachovat důležité informace
                if (displayText.length > 40) {
                    displayText = displayText.substring(0, 37) + '...';
                }
                text.textContent = displayText;
            }
        } else if (status.includes('Dokončeno') || status.includes('dokončeno')) {
            // Zobrazit krátce zprávu o dokončení
            indicator.style.display = 'flex';
            if (text) {
                text.textContent = 'Scrapování dokončeno';
            }
            // Skrýt po 2 sekundách
            setTimeout(() => {
                indicator.style.display = 'none';
            }, 2000);
        } else {
            indicator.style.display = 'none';
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatArea(text) {
        if (!text) return '';
        
        // Najít čísla následovaná různými formáty m²
        return text
            .replace(/(\d+)\s*m[2²]?/gi, '$1 m²')
            .replace(/(\d+)\s*m\s*(\d+)/gi, '$1,$2 m²')
            .replace(/(\d+)\s*metr[ůů]?\s*čtverečn[ýých]/gi, '$1 m²')
            .replace(/(\d+)\s*m2/gi, '$1 m²')
            .replace(/(\d+)\s*m\s*²/gi, '$1 m²')
            .replace(/(\d+)\s*čtverečn[ýých]\s*metr[ůů]?/gi, '$1 m²')
            .replace(/(\d+)\s*m\s*čtverečn[ýých]/gi, '$1 m²');
    }

    formatPrice(price) {
        const numPrice = parseInt(price.toString().replace(/\D/g, ''));
        return numPrice.toLocaleString('cs-CZ');
    }

    formatDateTime(dateTimeString) {
        if (!dateTimeString) return 'Neznámo';
        try {
            let date;
            // Handle custom format YYYYMMDD_HHMMSS from scraping_service
            if (typeof dateTimeString === 'string' && /^\d{8}_\d{6}$/.test(dateTimeString)) {
                const year = dateTimeString.substring(0, 4);
                const month = dateTimeString.substring(4, 6);
                const day = dateTimeString.substring(6, 8);
                const hours = dateTimeString.substring(9, 11);
                const minutes = dateTimeString.substring(11, 13);
                const seconds = dateTimeString.substring(13, 15);
                date = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}`);
            } else {
                // Pro standardní ISO formát - zajistit, aby JavaScript rozuměl formátu
                let isoString = dateTimeString;
                if (typeof isoString === 'string' && !isoString.includes('T') && isoString.includes(' ')) {
                    isoString = isoString.replace(' ', 'T');
                }
                date = new Date(isoString);
            }
            
            if (!date || isNaN(date.getTime())) return 'Neznámo';
            
            // Formát: DD.MM.YYYY HH:MM
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const year = date.getFullYear();
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return `${day}.${month}.${year} ${hours}:${minutes}`;
        } catch (e) {
            console.warn('Chyba při formátování data:', dateTimeString, e);
            return 'Neznámo';
        }
    }

    getLastUpdateTime(offer) {
        // Vrátit last_ping pokud existuje, jinak created_at nebo timestamp
        return offer.last_ping || offer.created_at || offer.timestamp || '';
    }

    async showOfferOnMap(offer) {
        // Zkontrolovat, zda už máme marker pro tuto nabídku
        const existingMarker = this.findMarkerForOffer(offer);
        if (existingMarker) {
            // Zajistit rozbalení clusteru a zobrazení markeru
            if (this.markerCluster && this.markerCluster.zoomToShowLayer) {
                this.markerCluster.zoomToShowLayer(existingMarker, () => {
                    existingMarker.openPopup();
                    // Při explicitním požadavku ukázat marker záměrně centrovat a nastavit rozumný zoom
                    const targetZoom = Math.max(this.map.getZoom(), 16);
                    this.map.setView(existingMarker.getLatLng(), targetZoom);
                });
            } else {
                existingMarker.openPopup();
                const targetZoom = Math.max(this.map.getZoom(), 16);
                this.map.setView(existingMarker.getLatLng(), targetZoom);
            }
            // Marker pro nabídku už existuje, pouze zvýrazněn
            return;
        }
        
        // Pokud nabídka už má souřadnice, použít je přímo
        if (offer.lat && offer.lng) {
            const marker = L.marker([offer.lat, offer.lng], { icon: this.createOfferIcon(1) });
            marker._groupOffers = [offer];
            marker._groupLocation = offer.location || 'Neznámá lokace';
            
            const popupContent = this.createScrollablePopup([offer], offer.location || 'Neznámá lokace');
            marker.bindPopup(popupContent, {
                maxWidth: 345,
                maxHeight: 400,
                keepInView: true,
                autoPan: true,
                autoPanPaddingTopLeft: [20, 20],
                autoPanPaddingBottomRight: [20, 20]
            });
            
            this.offerMarkers.push(marker);
            this.markerCluster.addLayer(marker);
            
            if (this.markerCluster && this.markerCluster.zoomToShowLayer) {
                this.markerCluster.zoomToShowLayer(marker, () => {
                    marker.openPopup();
                    const targetZoom = Math.max(this.map.getZoom(), 16);
                    this.map.setView([offer.lat, offer.lng], targetZoom);
                });
            } else {
                marker.openPopup();
                const targetZoom = Math.max(this.map.getZoom(), 16);
                this.map.setView([offer.lat, offer.lng], targetZoom);
            }
            return;
        }
        
        // Zobrazit loading indikátor
        const loadingMarker = L.marker([50.0755, 14.4378]).addTo(this.map);
        loadingMarker.bindPopup('<div class="scrollable-popup"><div class="popup-header"><h4>Načítám…</h4></div></div>').openPopup();
        
        try {
            // Odstranit loading marker
            this.map.removeLayer(loadingMarker);
            
            // Použít geokódování přes Nominatim API pouze pokud nemáme souřadnice
            const coords = await this.geocodeLocation(offer.location);
                
            if (coords) {
                const marker = L.marker([coords.lat, coords.lng], { icon: this.createOfferIcon(1) });
                marker._groupOffers = [offer];
                marker._groupLocation = offer.location || 'Neznámá lokace';
                this.markerCluster.addLayer(marker);
                
                const header = coords.address || offer.location || '';
                const popupContent = this.createScrollablePopup([{...offer, coords}], header);
                marker.bindPopup(popupContent, {
                    maxWidth: 345,
                    maxHeight: 400,
                    keepInView: true,
                    autoPan: true,
                    autoPanPaddingTopLeft: [20, 20],
                    autoPanPaddingBottomRight: [20, 20]
                });
                if (this.markerCluster && this.markerCluster.zoomToShowLayer) {
                    this.markerCluster.zoomToShowLayer(marker, () => {
                        marker.openPopup();
                        const targetZoom = Math.max(this.map.getZoom(), 16);
                        this.map.setView([coords.lat, coords.lng], targetZoom);
                    });
                } else {
                    marker.openPopup();
                    const targetZoom = Math.max(this.map.getZoom(), 16);
                    this.map.setView([coords.lat, coords.lng], targetZoom);
                }
                
                // Uložit marker pro pozdější vyčištění (pouze pokud neexistuje)
                if (!this.findMarkerForOffer(offer)) {
                    this.offerMarkers.push(marker);
                }
            } else {
                alert('Nepodařilo se najít souřadnice pro tuto lokaci');
            }
        } catch (error) {
            // Odstranit loading marker
            this.map.removeLayer(loadingMarker);
            // Chyba při geokódování
            alert('Chyba při hledání lokace na mapě');
        }
    }


    clearOfferMarkers() {
        if (this.markerCluster) this.markerCluster.clearLayers();
        this.offerMarkers = [];
    }
    
    showLoadingMessage(message) {
        // Tichý loader místo spamujících logů
        if (!this._loaderEl) {
            this._loaderEl = document.createElement('div');
            this._loaderEl.className = 'map-loader';
            this._loaderEl.innerHTML = '<div class="spinner"></div><span class="text"></span>';
            document.body.appendChild(this._loaderEl);
        }
        const textEl = this._loaderEl.querySelector('.text');
        if (textEl) textEl.textContent = message;
        this._loaderEl.style.display = 'flex';
        clearTimeout(this._loaderHideT);
        this._loaderHideT = setTimeout(() => {
            if (this._loaderEl) this._loaderEl.style.display = 'none';
        }, 1200);
    }
    
    showLoading(show) {
        const loadingElement = document.getElementById('loading');
        if (loadingElement) {
            loadingElement.style.display = show ? 'block' : 'none';
        }
        
        // Also show/hide loading indicator in offers container
        const offersContainer = document.getElementById('offers-container');
        if (offersContainer) {
            if (show) {
                offersContainer.classList.add('loading');
            } else {
                offersContainer.classList.remove('loading');
            }
        }
        
        // Zobrazit skeleton loader místo prázdného stavu
        const offersList = document.getElementById('offers-list');
        if (offersList && show) {
            offersList.innerHTML = this.getSkeletonLoaderHTML();
        }
    }
    
    getSkeletonLoaderHTML() {
        return `
            <div class="loading-skeleton">
                ${Array(6).fill(0).map(() => `
                    <div class="offer-card-skeleton">
                        <div class="skeleton-image"></div>
                        <div class="skeleton-content">
                            <div class="skeleton-line medium"></div>
                            <div class="skeleton-line short"></div>
                            <div class="skeleton-line"></div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }
    
    hideLoadingMessage() {
        if (this._loaderEl) {
            this._loaderEl.style.display = 'none';
        }
    }

    async loadAllOffersForMap() {
        // Načíst všechny nabídky pro mapu (neomezeno)
        try {
            // Načíst všechny geokódované nabídky z optimalizovaného endpointu
            const url = `/api/offers-map`;
            
            const response = await fetch(url, {
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            
            const data = await response.json();
            this.allOffersForMap = data.offers || [];
            
            // Pokud jsme načetli nabídky pro mapu, hned je zobrazíme
            if (this.allOffersForMap.length > 0) {
                this.displayOffersOnMap();
            }
        } catch (error) {
            console.error('Chyba při načítání všech nabídek pro mapu:', error);
            // Fallback na currentOffers pokud se nepodaří načíst všechny
            this.allOffersForMap = [...this.currentOffers];
        }
    }

    async displayOffersOnMap() {
        // Použít allOffersForMap pro zobrazení všech nabídek na mapě
        const offersToDisplay = (this.allOffersForMap && this.allOffersForMap.length > 0) ? 
                               this.allOffersForMap : 
                               this.currentOffers;
        
        if (!offersToDisplay || offersToDisplay.length === 0) {
            return;
        }
        
        // Filtrovat nabídky podle aktuálně nastavených filtrů v UI
        const filteredOffers = this.filterOffers(this.filterPingedOffers(offersToDisplay));
        
        // Filtrovat pouze nabídky s existujícími souřadnicemi pro okamžité zobrazení
        const offersWithCoords = filteredOffers.filter(o => o.lat && o.lng);
        
        if (offersWithCoords.length === 0) {
            this.clearOfferMarkers();
            return;
        }
        
        // Zobrazit na mapě
        await this.batchGeocodeAndGroup(offersWithCoords);
        
        // Přizpůsobit zoom mapy pokud uživatel ještě neinteragoval a máme markery
        const anyPopupOpen = this.offerMarkers.some(m => m.isPopupOpen && m.isPopupOpen());
        if (this.offerMarkers.length > 0 && !this.userInteractedWithMap && !anyPopupOpen && !this.initialLoadDone) {
            const group = new L.featureGroup(this.offerMarkers);
            this.map.fitBounds(group.getBounds().pad(0.1));
            this.initialLoadDone = true;
        }
    }
    
    async batchGeocodeAndGroup(offers, clearExisting = true) {
        // Seskupit nabídky podle souřadnic
        const coordGroups = new Map();
        
        for (const offer of offers) {
            const lat = offer.lat;
            const lng = offer.lng;
            
            if (!lat || !lng) continue;
            
            // Zaokrouhlit souřadnice na 5 desetinných míst pro seskupení
            const coordKey = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
            
            if (!coordGroups.has(coordKey)) {
                coordGroups.set(coordKey, []);
            }
            coordGroups.get(coordKey).push(offer);
        }
        
        // Pokud clearExisting, vyčistit markery
        if (clearExisting) {
            this.clearOfferMarkers();
        }
        
        // Vytvořit všechny markery najednou pro lepší výkon
        const newMarkers = [];
        
        // Zpracovat skupiny nabídek
        for (const [coordKey, coordOffers] of coordGroups) {
            const [latStr, lngStr] = coordKey.split(',');
            const lat = Number(latStr);
            const lng = Number(lngStr);
            
            const marker = L.marker([lat, lng], { icon: this.createOfferIcon(coordOffers.length) });
            
            // Uložit přidružené nabídky k markeru
            marker._groupOffers = coordOffers.map(offer => ({
                ...offer,
                coords: { lat, lng }
            }));
            marker._groupLocation = coordOffers[0].location || 'Neznámá lokace';
            
            // Použít funkci pro vytváření popupu
            marker.bindPopup(() => {
                const offers = Array.isArray(marker._groupOffers) ? marker._groupOffers : [];
                const location = marker._groupLocation || 'Neznámá lokace';
                return this.createScrollablePopup(offers, location);
            }, {
                maxWidth: 345,
                maxHeight: 400,
                keepInView: true,
                autoPan: true,
                autoPanPaddingTopLeft: [20, 20],
                autoPanPaddingBottomRight: [20, 20]
            });
            
            newMarkers.push(marker);
        }

        // Přidat všechny markery do clusteru najednou
        if (this.markerCluster && newMarkers.length > 0) {
            this.markerCluster.addLayers(newMarkers);
        }
        
        if (clearExisting) {
            this.offerMarkers = newMarkers;
        } else {
            this.offerMarkers = [...this.offerMarkers, ...newMarkers];
        }
    }
    
    findMarkerForOffer(offer) {
        // Najít marker na základě URL nabídky
        return this.offerMarkers.find(marker => {
            const popup = marker.getPopup();
            if (popup && popup.getContent()) {
                const content = popup.getContent();
                // getContent() může vrátit string nebo HTMLElement
                const contentString = typeof content === 'string' ? content : (content.innerHTML || content.textContent || '');
                // Hledat URL nabídky v popup obsahu
                return contentString.includes(`href="${offer.link}"`);
            }
            // Také zkontrolovat _groupOffers pokud existuje
            if (marker._groupOffers && Array.isArray(marker._groupOffers)) {
                return marker._groupOffers.some(o => o.link === offer.link || o.url === offer.link);
            }
            return false;
        });
    }

    getLocationKey(location) {
        // Normalizovat lokaci pro seskupení - extrahovat ulici
        const cleanLocation = location.toLowerCase()
            .replace(/praha\s*\d*/, '') // Odstranit "Praha" a číslo
            .replace(/^\s*,\s*/, '') // Odstranit úvodní čárku
            .replace(/\s*,\s*$/, '') // Odstranit koncovou čárku
            .trim();
        
        // Pokud je lokace příliš krátká nebo obecná, nepoužívat seskupení
        if (cleanLocation.length < 5 || 
            cleanLocation.includes('praha') || 
            cleanLocation.includes('čr') ||
            cleanLocation.includes('czech')) {
            return location; // Použít původní lokaci jako klíč
        }
        
        return cleanLocation;
    }

    createOfferIcon(count) {
        const isGroup = count && count > 1;
        const sizeClass = isGroup ? 'offer-marker--grouped' : 'offer-marker--single';
        const html = `<div class="offer-marker ${sizeClass}">${isGroup ? `<span class=\"offer-marker__count\">${count}</span>` : ''}</div>`;
        const size = isGroup ? 36 : 32;
        const half = Math.round(size / 2);
        return L.divIcon({
            className: 'offer-marker-wrapper',
            html: html,
            iconSize: [size, size],
            // anchor to visual center of circle
            iconAnchor: [half, half],
            // popup slightly above top edge of circle
            popupAnchor: [0, -half]
        });
    }
    
    createSingleMarker(group) {
        // Vytvořit nový marker
        let coords = group.coords;
        
        // Najít existující marker na stejných souřadnicích
        const existingMarker = this.offerMarkers.find(marker => {
            const markerCoords = marker.getLatLng();
            const distance = Math.sqrt(
                Math.pow(markerCoords.lat - coords.lat, 2) + 
                Math.pow(markerCoords.lng - coords.lng, 2)
            );
            return distance < 0.0001; // Velmi malá vzdálenost = stejné místo
        });
        
        if (existingMarker) {
            // Aktualizovat existující marker s novou nabídkou
            const current = Array.isArray(existingMarker._groupOffers) ? existingMarker._groupOffers : [];
            // Dedup podle linku
            const byLink = new Map();
            [...current, ...group.offers].forEach(o => {
                const key = (o.link || '').toString();
                if (!byLink.has(key)) byLink.set(key, o);
            });
            const merged = Array.from(byLink.values());
            existingMarker._groupOffers = merged;
            existingMarker._groupLocation = group.location;
            // Popup se automaticky aktualizuje při otevření díky funkci v bindPopup
            existingMarker.setIcon(this.createOfferIcon(merged.length));
            // Aktualizován existující marker
            return;
        }
        
        // Pokud jsou to defaultní Praha souřadnice a už máme hodně markerů, rozložit je
        if (coords.lat === 50.0755 && coords.lng === 14.4378 && this.offerMarkers.length > 5) {
            const defaultLocationCount = this.offerMarkers.filter(marker => {
                const markerCoords = marker.getLatLng();
                return markerCoords.lat === 50.0755 && markerCoords.lng === 14.4378;
            }).length;
            
            const angle = (defaultLocationCount * 2 * Math.PI) / Math.max(20, 1); // Rozložit do kruhu
            const radius = 0.005; // Menší kruh - přibližně 500m
            coords = {
                lat: 50.0755 + radius * Math.cos(angle),
                lng: 14.4378 + radius * Math.sin(angle)
            };
        }
        
        const marker = L.marker([coords.lat, coords.lng], { icon: this.createOfferIcon(group.offers.length) });
        
        // Uložit přidružené nabídky k markeru pro budoucí merge
        marker._groupOffers = Array.isArray(group.offers) ? group.offers.slice() : [];
        marker._groupLocation = group.location;
        
        // Použít funkci pro vytváření popupu, která vždy vezme aktuální nabídky z markeru
        marker.bindPopup(() => {
            const offers = Array.isArray(marker._groupOffers) ? marker._groupOffers : [];
            const location = marker._groupLocation || 'Neznámá lokace';
            return this.createScrollablePopup(offers, location);
        }, {
            maxWidth: 345,
            maxHeight: 400,
            keepInView: true,
            autoPan: true,
            autoPanPaddingTopLeft: [20, 20],
            autoPanPaddingBottomRight: [20, 20]
        });
        
        this.offerMarkers.push(marker);
        this.markerCluster.addLayer(marker);
        // Vytvořen nový marker
    }

    createGroupedMarkers(locationGroups) {
        let defaultLocationCount = 0; // Počítadlo pro rozložení defaultních lokací
        
        for (const [locationKey, group] of locationGroups) {
            let coords = group.coords;
            
            // Pokud jsou to defaultní Praha souřadnice, rozložit je do kruhu
            if (coords.lat === 50.0755 && coords.lng === 14.4378) {
                const angle = (defaultLocationCount * 2 * Math.PI) / Math.max(locationGroups.size, 1);
                const radius = 0.01; // Přibližně 1km
                coords = {
                    lat: 50.0755 + radius * Math.cos(angle),
                    lng: 14.4378 + radius * Math.sin(angle)
                };
                defaultLocationCount++;
            }
            
            const marker = L.marker([coords.lat, coords.lng], { icon: this.createOfferIcon(group.offers.length) });
            this.markerCluster.addLayer(marker);
            
            // Uložit přidružené nabídky k markeru
            marker._groupOffers = Array.isArray(group.offers) ? group.offers.slice() : [];
            marker._groupLocation = group.location;
            
            // Použít funkci pro vytváření popupu, která vždy vezme aktuální nabídky z markeru
            marker.bindPopup(() => {
                const offers = Array.isArray(marker._groupOffers) ? marker._groupOffers : [];
                const location = marker._groupLocation || 'Neznámá lokace';
                return this.createScrollablePopup(offers, location);
            }, {
                maxWidth: 345,
                maxHeight: 400,
                keepInView: true,
                autoPan: true,
                autoPanPaddingTopLeft: [20, 20],
                autoPanPaddingBottomRight: [20, 20]
            });
            
            this.offerMarkers.push(marker);
        }
    }
    
    createSingleOfferPopup(offer) {
        // Přesměrování na scrollovací popup pro jednotnou UI
        const header = this.shortenLocationLabel(offer.location || '');
        return this.createScrollablePopup([offer], header);
    }
    
    createScrollablePopup(offers, location) {
        const headerLabel = this.getHeaderLabel(offers, location);
        const offersHtml = offers.map(offer => {
            const thumb = offer.image_url || '/static/images/placeholder.svg';
            const title = this.escapeHtml(this.formatArea(offer.title));
            const price = this.formatPrice(offer.price);
            const source = (offer.scraper || '').toString();
            return `
                <li class="popup-item">
                    <a href="${offer.link}" target="_blank" rel="noopener noreferrer">
                        <img class="popup-thumb" src="${thumb}" alt="${title}" onerror="this.src='/static/images/placeholder.svg'" />
                        <div class="popup-body">
                            <div class="popup-title">${title}</div>
                            <div class="popup-row">
                                <span class="popup-price">${price} Kč/měsíc</span>
                                <span class="popup-source">${source}</span>
                            </div>
                        </div>
                        <span class="popup-arrow">›</span>
                    </a>
                </li>
            `;
        }).join('');

        return `
            <div class="scrollable-popup">
                <div class="popup-header">
                    <h4 title="${this.escapeHtml(this.formatArea(headerLabel))}">${this.escapeHtml(this.formatArea(headerLabel))}</h4>
                    <p class="offer-count">${offers.length} nabídek</p>
                </div>
                <ul class="popup-list">
                    ${offersHtml}
                </ul>
            </div>
        `;
    }

    getHeaderLabel(offers, fallbackLocation) {
        // Najít ulici
        const streetFromOffer = offers.map(o => (o.street_name || '').trim()).filter(Boolean)[0] || '';
        const streetFromLocation = (fallbackLocation || '').split(',')[0].trim();
        const street = streetFromOffer || streetFromLocation || '';

        // Najít 'Praha X' - hledat v district i city_part
        const districtFromOffer = offers.map(o => (o.district || '')).find(d => /praha\s*\d{1,2}/i.test(d)) || '';
        const cityPartFromOffer = offers.map(o => (o.city_part || '')).find(d => /praha\s*\d{1,2}/i.test(d)) || '';
        const prahaFromDistrict = (districtFromOffer.match(/praha\s*\d{1,2}/i) || [null])[0];
        const prahaFromCityPart = (cityPartFromOffer.match(/praha\s*\d{1,2}/i) || [null])[0];
        const prahaFromLocation = ((fallbackLocation || '').match(/praha\s*\d{1,2}/i) || [null])[0];
        const praha = prahaFromDistrict || prahaFromCityPart || prahaFromLocation || '';

        if (street && praha) return `${street}, ${praha.replace(/\s+/g, ' ').replace(/Praha/i, 'Praha')}`;
        if (street) return street;
        if (praha) return praha.replace(/\s+/g, ' ').replace(/Praha/i, 'Praha');
        return this.shortenLocationLabel(fallbackLocation || 'Praha');
    }

    shortenLocationLabel(text) {
        if (!text) return '';
        const parts = text.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length <= 2) return parts.join(', ');
        // Heuristic: keep Street and first district-like token
        const street = parts[0];
        const district = parts.find(p => /praha\s*\d|žižkov|vinohrady|smíchov|karlín|holešovice|dejvice|vršovice|nusle|libeň|vysočany/i.test(p)) || parts[1];
        return `${street}, ${district}`;
    }

    async geocodeLocation(location) {
        // Použít pouze server-side fuzzy location matcher (který používá lokální JSON data)
        try {
            return await this.geocodeWithServerAPI(location);
        } catch (error) {
            // Server geokódování selhalo - tichá
            return null;
        }
    }
    
    // Funkce geocodeWithServerAPI odstraněna - používáme lokální souřadnice z nabídek
    
    getPragueCoordinates(location) {
        // Základní souřadnice pro Prahu
        const pragueCoords = {
            lat: 50.0755,
            lng: 14.4378
        };
        
        if (!location) {
            return pragueCoords;
        }
        
        const locationLower = location.toLowerCase();
        
        // Rozšířené mapování pro známé lokace v Praze
        const locationMap = {
            // Praha čísla
            'praha 1': { lat: 50.0875, lng: 14.4214 },
            'praha 2': { lat: 50.0755, lng: 14.4378 },
            'praha 3': { lat: 50.0833, lng: 14.4500 },
            'praha 4': { lat: 50.0500, lng: 14.4500 },
            'praha 5': { lat: 50.0667, lng: 14.4000 },
            'praha 6': { lat: 50.1000, lng: 14.4000 },
            'praha 7': { lat: 50.1000, lng: 14.4500 },
            'praha 8': { lat: 50.1167, lng: 14.4500 },
            'praha 9': { lat: 50.1167, lng: 14.5000 },
            'praha 10': { lat: 50.0667, lng: 14.5000 },
            
            // Městské části
            'smíchov': { lat: 50.0667, lng: 14.4000 },
            'vinohrady': { lat: 50.0755, lng: 14.4378 },
            'žižkov': { lat: 50.0833, lng: 14.4500 },
            'karlín': { lat: 50.1000, lng: 14.4500 },
            'holešovice': { lat: 50.1000, lng: 14.4500 },
            'dejvice': { lat: 50.1000, lng: 14.4000 },
            'vršovice': { lat: 50.0500, lng: 14.4500 },
            'nusle': { lat: 50.0500, lng: 14.4500 },
            'libeň': { lat: 50.1167, lng: 14.4500 },
            'vysočany': { lat: 50.1167, lng: 14.5000 },
            'prosek': { lat: 50.1167, lng: 14.5000 },
            'letňany': { lat: 50.1333, lng: 14.5167 },
            'hradčany': { lat: 50.0875, lng: 14.4214 },
            'malá strana': { lat: 50.0875, lng: 14.4214 },
            'nové město': { lat: 50.0755, lng: 14.4378 },
            'staré město': { lat: 50.0875, lng: 14.4214 },
            'josefov': { lat: 50.0875, lng: 14.4214 },
            'modřany': { lat: 50.0167, lng: 14.4500 },
            'braník': { lat: 50.0333, lng: 14.4500 },
            'podolí': { lat: 50.0500, lng: 14.4500 },
            'krč': { lat: 50.0500, lng: 14.4500 },
            'lhotka': { lat: 50.0500, lng: 14.4500 },
            'chodov': { lat: 50.0333, lng: 14.5000 },
            'hostivař': { lat: 50.0500, lng: 14.5000 },
            'strašnice': { lat: 50.0833, lng: 14.5000 },
            'výšehrad': { lat: 50.0667, lng: 14.4167 },
            'pankrác': { lat: 50.0500, lng: 14.4500 },
            'budějovická': { lat: 50.0500, lng: 14.4500 },
            'kačerov': { lat: 50.0500, lng: 14.4500 },
            'michelská': { lat: 50.0500, lng: 14.4500 },
            'královské vinohrady': { lat: 50.0755, lng: 14.4378 },
            'želivského': { lat: 50.0833, lng: 14.4500 },
            'olšany': { lat: 50.0833, lng: 14.5000 },
            'malešice': { lat: 50.0833, lng: 14.5000 },
            'prosek': { lat: 50.1167, lng: 14.5000 },
            'střížkov': { lat: 50.1167, lng: 14.5000 },
            'kobylisy': { lat: 50.1167, lng: 14.4500 },
            'čakovice': { lat: 50.1500, lng: 14.5167 },
            'letňany': { lat: 50.1333, lng: 14.5167 },
            'kyje': { lat: 50.1000, lng: 14.5500 },
            'horní počernice': { lat: 50.1000, lng: 14.5500 },
            'dolní počernice': { lat: 50.1000, lng: 14.5500 },
            'březiněves': { lat: 50.1500, lng: 14.4500 },
            'dolní chabry': { lat: 50.1500, lng: 14.4500 },
            'horní chabry': { lat: 50.1500, lng: 14.4500 },
            'satalice': { lat: 50.1167, lng: 14.5500 },
            'vinoř': { lat: 50.1500, lng: 14.5500 },
            'měcholupy': { lat: 50.0167, lng: 14.5000 },
            'zbraslav': { lat: 49.9667, lng: 14.4000 },
            'radotín': { lat: 49.9833, lng: 14.3500 },
            'slivenec': { lat: 50.0167, lng: 14.3500 },
            'velká chuchle': { lat: 50.0167, lng: 14.3833 },
            'malá chuchle': { lat: 50.0167, lng: 14.3833 },
            'jinonice': { lat: 50.0500, lng: 14.3500 },
            'košíře': { lat: 50.0667, lng: 14.3500 },
            'motol': { lat: 50.0667, lng: 14.3500 },
            'řepy': { lat: 50.0833, lng: 14.3500 },
            'stodůlky': { lat: 50.0500, lng: 14.3500 },
            'luka': { lat: 50.0500, lng: 14.3500 },
            'velká ohrada': { lat: 50.0500, lng: 14.3500 },
            'malá ohrada': { lat: 50.0500, lng: 14.3500 },
            'břevnov': { lat: 50.0833, lng: 14.3500 },
            'hradčany': { lat: 50.0875, lng: 14.4214 },
            'malá strana': { lat: 50.0875, lng: 14.4214 },
            'nové město': { lat: 50.0755, lng: 14.4378 },
            'staré město': { lat: 50.0875, lng: 14.4214 },
            'josefov': { lat: 50.0875, lng: 14.4214 },
            
            // Hlavní ulice a náměstí
            'václavské náměstí': { lat: 50.0817, lng: 14.4269 },
            'staroměstské náměstí': { lat: 50.0875, lng: 14.4214 },
            'karlův most': { lat: 50.0865, lng: 14.4150 },
            'pražský hrad': { lat: 50.0905, lng: 14.3996 },
            'petřín': { lat: 50.0833, lng: 14.4000 },
            'letná': { lat: 50.1000, lng: 14.4167 },
            'národní třída': { lat: 50.0817, lng: 14.4167 },
            'na příkopě': { lat: 50.0817, lng: 14.4269 },
            'wenceslas square': { lat: 50.0817, lng: 14.4269 },
            'old town square': { lat: 50.0875, lng: 14.4214 },
            'charles bridge': { lat: 50.0865, lng: 14.4150 },
            'prague castle': { lat: 50.0905, lng: 14.3996 }
        };
        
        // Hledat přesnou shodu
        for (const [key, coords] of Object.entries(locationMap)) {
            if (locationLower.includes(key)) {
                return coords;
            }
        }
        
        // Pokud obsahuje "praha" ale není specifická lokace
        if (locationLower.includes('praha')) {
            return pragueCoords;
        }
        
        // Pokud neobsahuje "praha", vrátit střed Prahy jako fallback
        return pragueCoords;
    }







    async loadScrapers() {
        try {
            const response = await fetch('/api/stats');
            const data = await response.json();
            
            const scraperFilter = document.getElementById('scraper-filter');
            scraperFilter.innerHTML = '<option value="">Všechny servery</option>';
            
            Object.keys(data.by_scraper).forEach(scraper => {
                const option = document.createElement('option');
                option.value = scraper;
                option.textContent = scraper;
                scraperFilter.appendChild(option);
            });
        } catch (error) {
            // Chyba při načítání scraperů - tichá
        }
    }


    setupModal() {
        const modal = document.getElementById('settings-modal');
        const settingsBtn = document.getElementById('settings-btn');
        const closeBtn = document.querySelector('.close-btn');
        const cancelBtn = document.getElementById('cancel-settings');
        const saveBtn = document.getElementById('save-settings');

        // Otevření modalu
        settingsBtn.addEventListener('click', () => {
            modal.style.display = 'block';
        });

        // Zavření modalu
        const closeModal = () => {
            modal.style.display = 'none';
        };

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);

        // Zavření kliknutím mimo modal
        window.addEventListener('click', (event) => {
            if (event.target === modal) {
                closeModal();
            }
        });

        // Načtení nastavení při otevření modalu
        settingsBtn.addEventListener('click', async () => {
            modal.style.display = 'block';
            await this.loadSettings();
        });

        // Uložení nastavení
        saveBtn.addEventListener('click', async () => {
            const checkboxes = document.querySelectorAll('.disposition-item input[type="checkbox"]:checked');
            const dispositions = Array.from(checkboxes).map(cb => cb.value);
            
            if (dispositions.length === 0) {
                alert('Vyberte alespoň jednu dispozici!');
                return;
            }

            const autoRefresh = document.getElementById('auto-refresh')?.checked || true;
            const refreshInterval = parseInt(document.getElementById('refresh-interval')?.value || 10);

            try {
                // Uložit nastavení
                const settingsResponse = await fetch('/api/settings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        auto_refresh: autoRefresh,
                        refresh_interval: refreshInterval,
                        dispositions: dispositions
                    })
                });

                const settingsResult = await settingsResponse.json();
                if (!settingsResult.success) {
                    alert(`Chyba při ukládání nastavení: ${settingsResult.message}`);
                    return;
                }

                // Aktualizovat dispozice
                const response = await fetch('/api/update-dispositions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ dispositions: dispositions })
                });

                if (response.ok) {
                    closeModal();
                    // Načíst nabídky s novými filtry
                    await this.loadOffers();
                    alert('Filtry dispozic aktualizovány! Nabídky jsou načteny pro všechny dispozice.');
                } else {
                    alert('Chyba při ukládání nastavení');
                }
            } catch (error) {
                // Chyba při ukládání nastavení
                alert('Chyba při ukládání nastavení');
            }
        });

        // Cache management funkce
        const clearCacheBtn = document.getElementById('clear-cache-btn');
        const cleanupCacheBtn = document.getElementById('cleanup-cache-btn');
        const cacheStatsBtn = document.getElementById('cache-stats-btn');
        const aiStatus = document.getElementById('ai-processing-status');
        const aiProgress = document.getElementById('ai-progress');
        
        // Vymazání cache
        if (clearCacheBtn) {
            clearCacheBtn.addEventListener('click', async () => {
                try {
                    aiStatus.className = 'ai-status processing';
                    aiStatus.textContent = 'Mažu cache...';
                    clearCacheBtn.disabled = true;
                    
                    const response = await fetch('/api/clear-cache', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        }
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        aiStatus.className = 'ai-status success';
                        aiStatus.textContent = `✅ ${result.message}`;
                        currentOfferIndex = 0;
                        
                        // Načíst prázdné nabídky
                        await this.loadOffers();
                    } else {
                        aiStatus.className = 'ai-status error';
                        aiStatus.textContent = `❌ ${result.message}`;
                    }
                } catch (error) {
                    // Chyba při mazání cache
                    aiStatus.className = 'ai-status error';
                    aiStatus.textContent = '❌ Chyba při mazání cache';
                } finally {
                    clearCacheBtn.disabled = false;
                }
            });
        }
        
        // Vyčištění cache odkazů
        if (cleanupCacheBtn) {
            cleanupCacheBtn.addEventListener('click', async () => {
                try {
                    cleanupCacheBtn.disabled = true;
                    aiStatus.className = 'ai-status processing';
                    aiStatus.textContent = 'Čistím cache odkazů...';
                    
                    const response = await fetch('/api/cleanup-cache', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ max_age_days: 1 })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        aiStatus.className = 'ai-status success';
                        aiStatus.textContent = `✅ ${result.message}`;
                        
                        // Načíst aktualizované nabídky
                        await this.loadOffers();
                    } else {
                        aiStatus.className = 'ai-status error';
                        aiStatus.textContent = `❌ ${result.message}`;
                    }
                } catch (error) {
                    // Chyba při čištění cache
                    aiStatus.className = 'ai-status error';
                    aiStatus.textContent = '❌ Chyba při čištění cache';
                } finally {
                    cleanupCacheBtn.disabled = false;
                }
            });
        }
        
        // Statistiky cache
        if (cacheStatsBtn) {
            cacheStatsBtn.addEventListener('click', async () => {
                try {
                    cacheStatsBtn.disabled = true;
                    aiStatus.className = 'ai-status processing';
                    aiStatus.textContent = 'Načítám statistiky cache...';
                    
                    const response = await fetch('/api/cache-stats');
                    const result = await response.json();
                    
                    if (result.success) {
                        const stats = result.stats;
                        aiStatus.className = 'ai-status success';
                        aiStatus.innerHTML = `
                            <strong>Statistiky cache:</strong><br>
                            Celkem odkazů: ${stats.total_links}<br>
                            Aktivní odkazy: ${stats.active_links}<br>
                            Neplatné odkazy: ${stats.inactive_links}<br>
                            Poslední kontrola: ${stats.last_check ? new Date(stats.last_check).toLocaleString() : 'Nikdy'}<br>
                            Nabídek v cache: ${result.offers_cache_size}
                        `;
                    } else {
                        aiStatus.className = 'ai-status error';
                        aiStatus.textContent = `❌ ${result.message}`;
                    }
                } catch (error) {
                    // Chyba při načítání statistik
                    aiStatus.className = 'ai-status error';
                    aiStatus.textContent = '❌ Chyba při načítání statistik';
                } finally {
                    cacheStatsBtn.disabled = false;
                }
            });
        }
    }

    showOfferModal(index) {
        // Použít cache filtrovaných nabídek
        const offer = this.filteredOffersCache[index];
        
        if (!offer) return;
        
        const modal = document.getElementById('offer-modal');
        const modalContent = modal.querySelector('.modal-body #modal-content');
        
        modalContent.innerHTML = `
            <div class="modal-offer-detail">
                <div class="modal-offer-image">
                    ${offer.image_url ? 
                        `<img src="${offer.image_url}" alt="${this.escapeHtml(offer.title)}">` : 
                        `<div class="placeholder">Obrázek není k dispozici</div>`
                    }
                </div>
                <div class="modal-offer-title">${this.escapeHtml(this.formatArea(offer.title))}</div>
                <div class="modal-offer-location">${this.escapeHtml(this.formatArea(offer.location))}</div>
                <div class="modal-offer-price">${this.formatPrice(offer.price)} Kč/měsíc</div>
                <div class="modal-offer-update-time">
                    Aktualizováno: ${this.formatDateTime(this.getLastUpdateTime(offer))}
                </div>
                <div id="extra-detail-container">
                    <button id="load-extra-detail-btn" class="btn btn-outline btn-full" onclick="window.pragueApp.loadOfferExtraDetail(${index})">
                        Načíst více fotografií a popis
                    </button>
                </div>
                <div class="modal-offer-description">${offer.description ? this.escapeHtml(this.formatArea(offer.description)) : 'Popisek není k dispozici'}</div>
                <div class="modal-offer-actions">
                    <a href="${offer.link}" target="_blank" class="modal-offer-link" aria-label="Otevřít původní nabídku v novém okně">
                        Zobrazit původní nabídku
                    </a>
                    <button class="modal-offer-link" onclick="window.pragueApp.showOfferOnMapFromModal(${index})" aria-label="Ukázat nabídku na mapě">
                        Ukázat na mapě
                    </button>
                </div>
            </div>
        `;
        
        // Aktualizovat ARIA atributy
        modal.setAttribute('aria-hidden', 'false');
        modal.style.display = 'block';
        modal.classList.add('show');
        
        // Přidat třídu na body pro rozmazání ovládacích prvků mapy
        document.body.classList.add('modal-open');
        
        // Uložit předchozí focus pro návrat
        this.previousFocus = document.activeElement;
        
        // Focus na první interaktivní prvek v modalu
        const firstFocusable = modal.querySelector('.modal-close, .modal-offer-link, button');
        if (firstFocusable) {
            firstFocusable.focus();
        }
        
        // Přidat event listener pro zavření modalu
        const closeBtn = modal.querySelector('.modal-close');
        const closeBtnFooter = modal.querySelector('.modal-close-btn');
        
        const closeModalHandler = () => this.closeModal();
        
        if (closeBtn) {
            closeBtn.onclick = closeModalHandler;
        }
        if (closeBtnFooter) {
            closeBtnFooter.onclick = closeModalHandler;
        }
        
        // Zavřít modal při kliknutí mimo obsah
        modal.onclick = (e) => {
            if (e.target === modal) {
                this.closeModal();
            }
        };
    }
    
    closeModal() {
        const modal = document.getElementById('offer-modal');
        if (!modal) return;
        
        modal.setAttribute('aria-hidden', 'true');
        modal.style.display = 'none';
        modal.classList.remove('show');
        
        // Odebrat třídu z body pro obnovení ovládacích prvků mapy
        document.body.classList.remove('modal-open');
        
        // Vrátit focus na předchozí prvek
        if (this.previousFocus) {
            this.previousFocus.focus();
        }
    }

    showOfferOnMapFromModal(index) {
        // Použít cache filtrovaných nabídek
        const offer = this.filteredOffersCache[index];
        
        if (!offer) return;
        
        // Zavřít modal
        this.closeModal();
        
        // Zobrazit nabídku na mapě
        this.showOfferOnMap(offer);
    }

    async loadOfferExtraDetail(index) {
        const offer = this.filteredOffersCache[index];
        if (!offer) return;

        const btn = document.getElementById('load-extra-detail-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<div class="loading-spinner loading-spinner--small"></div> Načítám více detailů...';
        }

        try {
            const response = await fetch('/api/offer-detail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    link: offer.link,
                    scraper: offer.scraper
                })
            });

            const data = await response.json();
            if (data.success && data.detail) {
                const detail = data.detail;
                
                // Update description if available
                if (detail.description) {
                    offer.description = detail.description;
                    const descElem = document.querySelector('.modal-offer-description');
                    if (descElem) {
                        descElem.innerHTML = this.escapeHtml(this.formatArea(detail.description)).replace(/\n/g, '<br>');
                    }
                }

                // Show more images if available
                if (detail.images && detail.images.length > 0) {
                    const imgContainer = document.querySelector('.modal-offer-image');
                    if (imgContainer) {
                        imgContainer.innerHTML = `
                            <div class="modal-offer-gallery">
                                ${detail.images.map(img => `
                                    <div class="gallery-image" onclick="window.open('${img}', '_blank')">
                                        <img src="${img}" alt="${this.escapeHtml(offer.title)}" loading="lazy">
                                    </div>
                                `).join('')}
                            </div>
                        `;
                    }
                }

                if (btn) btn.style.display = 'none';
            } else {
                if (btn) {
                    btn.textContent = 'Nepodařilo se načíst detaily';
                    btn.classList.add('btn-error');
                    setTimeout(() => {
                        if (btn) {
                            btn.disabled = false;
                            btn.classList.remove('btn-error');
                            btn.textContent = 'Načíst více fotografií a popis';
                        }
                    }, 3000);
                }
            }
        } catch (error) {
            console.error('Error loading extra detail:', error);
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Chyba při načítání';
            }
        }
    }

    async startAutomaticPinging() {
        // Deprecated - pingování se nyní děje automaticky při renderování viditelných nabídek
        // Tato funkce je ponechána pro zpětnou kompatibilitu
        return;
    }
    
    // Pingování viditelných nabídek - volá se po renderování
    async pingVisibleOffers(offers) {
        if (!offers || offers.length === 0) return;
        
        // Debounce - čekat 500ms před pingováním
        if (this.pingDebounceTimer) {
            clearTimeout(this.pingDebounceTimer);
        }
        
        this.pingDebounceTimer = setTimeout(async () => {
            await this._doPingVisible(offers);
        }, 500);
    }
    
    async _doPingVisible(offers) {
        if (this.pingInProgress) return;
        
        // Filtrovat pouze nabídky, které ještě nebyly pingovány v této session
        const linksToPing = offers
            .filter(o => {
                const link = o.link || o.url;
                if (!link) return false;
                if (this.pingedLinks.has(link)) return false;
                // Pokud už má platný ping, přeskočit
                if (o.last_ping_is_valid !== undefined) return false;
                return true;
            })
            .map(o => o.link || o.url)
            .slice(0, 50); // Max 50 nabídek najednou
        
        if (linksToPing.length === 0) return;
        
        this.pingInProgress = true;
        
        try {
            const response = await fetch('/api/ping-visible', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ links: linksToPing })
            });
            
            if (!response.ok) {
                console.warn('Ping request failed:', response.status);
                return;
            }
            
            const data = await response.json();
            
            if (data.success && data.results) {
                // Označit pinované linky
                data.results.forEach(r => {
                    if (r.link) {
                        this.pingedLinks.add(r.link);
                    }
                });
                
                // Aktualizovat nabídky v cache s výsledky pingování
                const linkToResult = new Map(data.results.map(r => [r.link, r]));
                
                // Aktualizovat currentOffers
                this.currentOffers = this.currentOffers.map(offer => {
                    const link = offer.link || offer.url;
                    const result = linkToResult.get(link);
                    if (result) {
                        return {
                            ...offer,
                            last_ping_is_valid: result.is_valid,
                            last_ping: result.ping_time || new Date().toISOString()
                        };
                    }
                    return offer;
                });
                
                // Pokud byly nějaké neplatné, odebrat je a překreslit
                if (data.invalid_count > 0) {
                    const invalidLinks = new Set(
                        data.results.filter(r => !r.is_valid).map(r => r.link)
                    );
                    this.currentOffers = this.currentOffers.filter(o => {
                        const link = o.link || o.url;
                        return !invalidLinks.has(link);
                    });
                    // Použít renderSidebarOnly místo renderOffers, aby se zabránilo loopu
                    this.renderSidebarOnly(true);
                }
            }
        } catch (error) {
            console.error('Chyba při pingování viditelných nabídek:', error);
        } finally {
            this.pingInProgress = false;
        }
    }

    // Stará funkce odstraněna - nyní používáme pingVisibleOffers

    async displayPingedOffersOnMap(pingedOffers) {
        // Deprecated - používáme pingVisibleOffers
        return;
    }

    async startScrapingAfterPing() {
        // Zabránit opakovanému volání - pokud už běží nebo už bylo spuštěno, přeskočit
        if (this.scrapingInProgress || this.scrapingStartedAfterPing) {
            return;
        }
        
        this.scrapingStartedAfterPing = true; // Označit, že už bylo spuštěno
        
        try {
            this.scrapingInProgress = true;
            // Resetovat počítadlo nabídek pro sledování nových - použít valid_count místo cache_count
            const statusResponse = await fetch('/api/status');
            const statusData = await statusResponse.json();
            this.lastOfferCount = statusData.valid_count || statusData.cache_count || 0;
            
            // Spouštím scrapování nových nabídek
            // this.showNotification('Spouštím scrapování nových nabídek...'); // Odstraněno - duplicitní
            
            const response = await fetch('/api/start-scraping', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });
            
            const data = await response.json();
            
            if (data.success) {
                // Scrapování spuštěno
                this.showNotification('Scrapování nových nabídek spuštěno!');
                
                // Sledovat progress scrapování
                this.monitorScrapingProgress();
            } else {
                // Chyba při spuštění scrapování nebo už běží
                if (data.message && data.message.includes('již běží')) {
                    // Scrapování už běží - to je v pořádku, jen resetovat flag
                    this.scrapingStartedAfterPing = false;
                } else {
                    this.showNotification(`Chyba při spuštění scrapování: ${data.message}`);
                    this.scrapingInProgress = false;
                    this.scrapingStartedAfterPing = false; // Resetovat flag při chybě
                }
            }
        } catch (error) {
            // Chyba při spuštění scrapování
            this.showNotification('Chyba při spuštění scrapování');
            this.scrapingInProgress = false;
            this.scrapingStartedAfterPing = false; // Resetovat flag při chybě
        }
    }

    async monitorScrapingProgress() {
        // Sledovat progress scrapování každé 2 sekundy pro rychlejší aktualizaci
        const checkInterval = setInterval(async () => {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                const fetchingStatus = data.fetching_status || '';
                const isScrapingActive = fetchingStatus && (
                    fetchingStatus.includes('Zpracovávám') || 
                    fetchingStatus.includes('Začínám') || 
                    fetchingStatus.includes('Scrapování') ||
                    fetchingStatus.includes('Auto-zpracováno')
                );
                
                // Aktualizovat indikátor zpracování pokud existuje
                if (fetchingStatus) {
                    this.updateProcessingIndicator(fetchingStatus);
                }
                
                // Průběžně načítat nové nabídky během scrapování - použít valid_count místo cache_count
                const currentOfferCount = data.valid_count || data.cache_count || 0;
                if (currentOfferCount > this.lastOfferCount) {
                    const newCount = currentOfferCount - this.lastOfferCount;
                    this.lastOfferCount = currentOfferCount;
                    
                    // Načíst nové nabídky a zobrazit je
                    try {
                        // Načíst všechny nové nabídky (nejnovější první)
                        const offersResponse = await fetch(`/api/offers?limit=${Math.max(newCount + 50, 100)}&sort=newest`);
                        const offersData = await offersResponse.json();
                        
                        if (offersData.offers && offersData.offers.length > 0) {
                            // Přidat pouze nové nabídky, které ještě nejsou v seznamu
                            const existingLinks = new Set(this.currentOffers.map(o => o.link || o.url));
                            const newOffers = offersData.offers.filter(o => {
                                const link = o.link || o.url;
                                return link && !existingLinks.has(link);
                            });
                            
                            if (newOffers.length > 0) {
                                // Přidat nové nabídky na začátek seznamu
                                this.currentOffers.unshift(...newOffers);
                                this.renderOffers();
                                
                                // Aktualizovat počet - použít celkový počet z API
                                const totalActiveCount = offersData.active_count || offersData.pagination?.total_count || this.currentOffers.length;
                                this.updateActiveCount(totalActiveCount);
                                
                                // Zobrazit na mapě
                                await this.batchGeocodeAndGroup(newOffers);
                                
                                // Auto-zoom pokud uživatel neinteragoval
                                const anyPopupOpen = this.offerMarkers.some(m => m.isPopupOpen && m.isPopupOpen());
                                if (this.offerMarkers.length > 0 && !this.userInteractedWithMap && !anyPopupOpen) {
                                    const group = new L.featureGroup(this.offerMarkers);
                                    this.map.fitBounds(group.getBounds().pad(0.1));
                                }
                                
                                // Zobrazit notifikaci o nových nabídkách
                                this.showNotification(`Načteno ${newOffers.length} nových nabídek!`, 'success');
                            }
                        }
                    } catch (error) {
                        // Chyba při načítání nových nabídek - tichá
                        console.error('Chyba při načítání nových nabídek:', error);
                    }
                }
                
                // Pokud se scrapování dokončilo nebo už neběží, načíst všechny nové nabídky
                const isFinished = fetchingStatus.includes('Dokončeno') || 
                                  fetchingStatus.includes('dokončeno') ||
                                  fetchingStatus.includes('FETCHOVÁNÍ DOKONČENO') ||
                                  (!isScrapingActive && this.scrapingInProgress);
                
                if (isFinished) {
                    clearInterval(checkInterval);
                    this.scrapingInProgress = false;
                    this.scrapingStartedAfterPing = false; // Resetovat flag po dokončení
                    
                    // Počkat chvíli, aby se backend stihl aktualizovat
                    setTimeout(async () => {
                        // Scrapování dokončeno, načítám všechny nové nabídky
                        this.showNotification('Scrapování dokončeno! Načítám nové nabídky...');
                        
                        // Načíst všechny nové nabídky (bez automatického pingování a scrapování)
                        await this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
                        
                        // Resetovat počítadla pro další kontrolu
                        const statusResponse = await fetch('/api/status');
                        const statusData = await statusResponse.json();
                        this.lastKnownOfferCount = statusData.valid_count || statusData.cache_count || 0;
                        this.lastKnownUpdateTime = statusData.last_update || null;
                    }, 2000); // Počkat 2 sekundy
                }
            } catch (error) {
                // Chyba při sledování progressu - tichá
                console.error('Chyba při sledování progressu:', error);
            }
        }, 2000); // Kontrolovat každé 2 sekundy pro rychlejší aktualizaci
        
        // Zastavit sledování po 10 minutách
        setTimeout(() => {
            clearInterval(checkInterval);
            // Pokud stále běží scrapování, načíst nabídky na konci
            if (this.scrapingInProgress) {
                this.scrapingInProgress = false;
                this.scrapingStartedAfterPing = false;
                this.loadOffers(this.selectedDistrict, { noScrape: true, noPing: true });
            }
        }, 10 * 60 * 1000);
    }
}

// Inicializace aplikace po načtení stránky
document.addEventListener('DOMContentLoaded', () => {
    window.pragueApp = new PragueRentalApp();
    const app = window.pragueApp;
    
    // Načtení scraperů pro filtr
    app.loadScrapers();
    
    // Automatické sledování statusu odstraněno - způsobovalo loop
    
    // Automatické načítání odstraněno - způsobovalo loop
    
    // Automatická aktualizace odstraněna - způsobovala loop
});
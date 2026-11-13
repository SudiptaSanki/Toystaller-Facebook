// overlay_manager.js
// Tracks media elements and positions action buttons safely on document.body.
// v4: Section-aware modal suppression, zero-bleed backdrop isolation, smart corner placement,
//     clamped-inside-frame positioning, per-section toggle support.

class OverlayManager {
    constructor() {
        this.overlays = new Map();
        this.activeEntry = null;
        this.hideTimeout = null;

        // Per-section toggle settings (loaded from chrome.storage)
        this._sectionToggles = {
            toystaller_fb_show_feed:    true,
            toystaller_fb_show_watch:   true,
            toystaller_fb_show_reels:   true,
            toystaller_fb_show_stories: true,
            toystaller_fb_show_photos:  true
        };
        this._loadToggles();

        // Listen for settings changes from popup
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener((msg) => {
                if (msg && msg.action === 'toystaller_settings_changed') {
                    this._sectionToggles[msg.key] = msg.value;
                    this.updateAllPositions();
                }
            });
        }

        this._onMouseMove = this._throttle(this._handlePointerMove.bind(this), 30);
        document.addEventListener('mousemove', this._onMouseMove, true);
        document.addEventListener('pointermove', this._onMouseMove, true);

        window.addEventListener('scroll', () => {
            if (this.activeEntry) {
                this._hide(this.activeEntry);
                this.activeEntry = null;
            }
            this.updateAllPositions();
        }, { passive: true, capture: true });
        window.addEventListener('resize', () => this.updateAllPositions());

        // Instant click dismiss — when clicking outside an overlay (e.g. opening Facebook menu or Share modal), immediately hide active overlay
        window.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('.magic-dl-overlay')) return;
            for (const entry of this.overlays.values()) {
                this._hide(entry);
            }
            this.activeEntry = null;
        }, true);

        // Instant modal listener — when a dialog/modal opens or closes, immediately sync overlay visibility
        this._modalObserver = new MutationObserver(() => {
            this.updateAllPositions();
        });
        const obsTarget = document.documentElement || document.body;
        if (obsTarget) {
            this._modalObserver.observe(obsTarget, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['role', 'aria-modal', 'class']
            });
        }

        setInterval(() => this.updateAllPositions(), 1000);
    }

    _loadToggles() {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get(Object.keys(this._sectionToggles), (result) => {
                    if (chrome.runtime.lastError) return;
                    for (const key of Object.keys(this._sectionToggles)) {
                        if (result[key] !== undefined && result[key] !== null) {
                            this._sectionToggles[key] = result[key];
                        }
                    }
                    this.updateAllPositions();
                });
            }
        } catch(e) { /* storage unavailable */ }
    }

    _isSectionDisabledByToggle() {
        const platform = this._getPlatform();
        if (!platform || !platform.getSection) return false;
        const section = platform.getSection();

        // Modals (Theater mode) are ALWAYS enabled (never toggled off)
        if (section === 'modal') return false;

        // Map sections to toggle keys
        if (section === 'feed' || section === 'groups') return !this._sectionToggles.toystaller_fb_show_feed;
        if (section === 'watch') return !this._sectionToggles.toystaller_fb_show_watch;
        if (section === 'reels') return !this._sectionToggles.toystaller_fb_show_reels;
        if (section === 'stories') return !this._sectionToggles.toystaller_fb_show_stories;
        if (section === 'photos' || section.startsWith('profile_') || section === 'friends') return !this._sectionToggles.toystaller_fb_show_photos;

        return false;
    }

    _getTopNavHeight() {
        const banner = document.querySelector('header[role="banner"], div[role="banner"], [role="banner"], #header');
        if (banner) {
            const bRect = banner.getBoundingClientRect();
            if (bRect.top <= 10 && bRect.bottom >= 40 && bRect.bottom <= 120) {
                return bRect.bottom;
            }
        }
        return 56;
    }

    _getPlatform() {
        if (typeof PlatformManager !== 'undefined') {
            return PlatformManager.getPlatform();
        }
        if (window.ToystallerActivePlatform) {
            return window.ToystallerActivePlatform;
        }
        if (window.ToystallerPlatforms && window.ToystallerPlatforms['facebook']) {
            return window.ToystallerPlatforms['facebook'];
        }
        return null;
    }

    _throttle(fn, ms) {
        let last = 0;
        let pending = null;
        return (...args) => {
            const now = Date.now();
            const run = () => {
                last = Date.now();
                pending = null;
                fn(...args);
            };
            if (now - last >= ms) {
                run();
            } else if (!pending) {
                pending = setTimeout(run, ms - (now - last));
            }
        };
    }

    _findHoverHost(media) {
        const platform = this._getPlatform();
        if (platform && platform.getHoverHost) {
            const host = platform.getHoverHost(media);
            if (host && host.isConnected) {
                const hostRect = host.getBoundingClientRect();
                const mediaRect = media.getBoundingClientRect();
                const section = platform.getSection ? platform.getSection() : '';
                // In friends list or card grids, the host card is naturally wider than the avatar
                if (section === 'friends' && hostRect.width > 0 && hostRect.height > 0) {
                    return host;
                }
                if (mediaRect.width > 0 && hostRect.width <= Math.max(mediaRect.width * 2.6, mediaRect.width + 80)) {
                    return host;
                }
                if (mediaRect.width === 0) return host;
            }
        }

        const mediaRect = media.getBoundingClientRect();
        if (mediaRect.width === 0 || mediaRect.height === 0) return media;

        let host = media;
        let node = media.parentElement;

        for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
            const rect = node.getBoundingClientRect();
            if (rect.width < 40 || rect.height < 40) break;

            const wRatio = rect.width / mediaRect.width;
            const hRatio = rect.height / mediaRect.height;

            if (wRatio >= 0.8 && wRatio <= 1.35 && hRatio >= 0.8 && hRatio <= 1.35) {
                host = node;
            } else {
                break;
            }
        }

        return host;
    }

    _isClippedByAncestor(media) {
        const mediaRect = media.getBoundingClientRect();
        if (mediaRect.width === 0 || mediaRect.height === 0) return true;

        let node = media.parentElement;
        let depth = 0;

        while (node && node !== document.body && node !== document.documentElement && depth < 15) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const style = window.getComputedStyle(node);
                if (style.overflow === 'hidden' || style.overflow === 'scroll' || style.overflow === 'auto' || 
                    style.overflowY === 'hidden' || style.overflowY === 'scroll' || style.overflowY === 'auto' ||
                    style.overflowX === 'hidden' || style.overflowX === 'scroll' || style.overflowX === 'auto') {
                    
                    const parentRect = node.getBoundingClientRect();
                    
                    const intersectLeft = Math.max(mediaRect.left, parentRect.left);
                    const intersectTop = Math.max(mediaRect.top, parentRect.top);
                    const intersectRight = Math.min(mediaRect.right, parentRect.right);
                    const intersectBottom = Math.min(mediaRect.bottom, parentRect.bottom);
                    
                    const intersectWidth = intersectRight - intersectLeft;
                    const intersectHeight = intersectBottom - intersectTop;
                    
                    if (intersectWidth <= 0 || intersectHeight <= 0) {
                        return true;
                    }
                    
                    const intersectArea = intersectWidth * intersectHeight;
                    const mediaArea = mediaRect.width * mediaRect.height;
                    
                    if (intersectArea / mediaArea < 0.4) {
                        return true;
                    }
                }
            }
            node = node.parentElement;
            depth++;
        }
        return false;
    }

    _pointInRect(x, y, rect) {
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    _getHoverRect(media, entry) {
        const mediaRect = media.getBoundingClientRect();
        if (!entry.hoverHost || entry.hoverHost === media) return mediaRect;
        const hostRect = entry.hoverHost.getBoundingClientRect();

        const platform = this._getPlatform();
        const inModal = platform && platform.isInsideModal ? platform.isInsideModal(media) : false;

        if (inModal) {
            if (hostRect.width >= mediaRect.width * 0.8 && hostRect.height >= mediaRect.height * 0.8) {
                return hostRect;
            }
            return mediaRect;
        }

        // Outside modal: limit host bounds to prevent swallowing sibling cards
        if (hostRect.width >= mediaRect.width * 0.8 && hostRect.width <= Math.max(mediaRect.width * 1.5, mediaRect.width + 40) &&
            hostRect.height >= mediaRect.height * 0.8 && hostRect.height <= Math.max(mediaRect.height * 1.5, mediaRect.height + 40)) {
            return hostRect;
        }
        return mediaRect;
    }

    _handlePointerMove(e) {
        const x = e.clientX;
        const y = e.clientY;

        const platform = this._getPlatform();
        const hasModal = platform && platform.hasActiveModal ? platform.hasActiveModal() : false;
        const hasMenu = platform && platform.hasActiveMenu ? platform.hasActiveMenu() : false;
        const hasNonTheaterModal = platform && platform.hasActiveNonTheaterModal ? platform.hasActiveNonTheaterModal() : false;

        // If a Facebook context menu or non-theater modal (e.g. Share dialog, composer) is open,
        // strictly suppress all overlays and eliminate background bleed-through
        if (hasMenu || hasNonTheaterModal) {
            this._scheduleHide();
            for (const entry of this.overlays.values()) {
                this._hide(entry);
            }
            return;
        }

        const topNavHeight = hasModal ? 0 : this._getTopNavHeight();

        // Top navigation bar guard: cursor is in the header, hide overlays
        if (y <= topNavHeight) {
            this._scheduleHide();
            return;
        }

        // Use document.elementsFromPoint to ensure we only trigger elements the user is directly viewing
        const hits = document.elementsFromPoint(x, y);
        if (!hits || hits.length === 0) {
            this._scheduleHide();
            return;
        }

        // Check if cursor is over ANY overlying Facebook UI layer (modals, dialogs, menus, tooltips, popups, dropdowns)
        const overlyingElement = hits.find(el => {
            if (!el || el === document.body || el === document.documentElement) return false;
            if (el.closest('.magic-dl-overlay')) return false;
            return el.closest('[role="dialog"], [aria-modal="true"], div.layerContainer, [role="menu"], [role="listbox"], [role="combobox"], [role="tooltip"], div[data-pagelet*="Menu" i], [aria-label*="Menu" i]');
        });

        if (overlyingElement) {
            const layer = overlyingElement.closest('[role="dialog"], [aria-modal="true"], div.layerContainer, [role="menu"], [role="listbox"], [role="combobox"], [role="tooltip"], div[data-pagelet*="Menu" i], [aria-label*="Menu" i]');
            let hasMediaInLayer = false;
            for (const [media, entry] of this.overlays.entries()) {
                if (layer && layer.contains(media) && this._pointInRect(x, y, media.getBoundingClientRect())) {
                    hasMediaInLayer = true;
                    break;
                }
            }
            if (!hasMediaInLayer) {
                this._scheduleHide();
                for (const entry of this.overlays.values()) {
                    this._hide(entry);
                }
                return;
            }
        }

        let hoverCandidates = [];

        // 1. Check if hovering directly over an existing button
        for (const [media, entry] of this.overlays.entries()) {
            // Modal isolation: If a modal is open, strictly ignore any media not inside the modal
            if (hasModal && platform && platform.isInsideModal && !platform.isInsideModal(media)) {
                if (entry.container.style.display !== 'none') {
                    entry.container.style.display = 'none';
                    entry.container.style.visibility = 'hidden';
                }
                continue;
            }

            if (entry.container.style.display === 'none') continue;

            // If an overlying element covers this point and media is not inside it, ignore button hit!
            if (overlyingElement && !overlyingElement.contains(media)) {
                continue;
            }

            const btnRect = entry.container.getBoundingClientRect();
            if (btnRect.width > 0 && this._pointInRect(x, y, btnRect)) {
                this._show(entry);
                return;
            }

            // Skip if visually clipped inside a scroll container
            if (this._isClippedByAncestor(media)) continue;

            const hoverRect = this._getHoverRect(media, entry);
            if (hoverRect.width > 0 && hoverRect.height > 0 && this._pointInRect(x, y, hoverRect)) {
                hoverCandidates.push({ media, entry });
            }
        }

        if (hoverCandidates.length === 0) {
            this._scheduleHide();
            return;
        }

        let matchedCandidates = [];

        for (const candidate of hoverCandidates) {
            const entry = candidate.entry;
            const media = candidate.media;

            // If an overlying modal or menu covers this point and candidate is not inside it, skip candidate!
            if (overlyingElement && !overlyingElement.contains(media)) {
                continue;
            }

            const mRect = media.getBoundingClientRect();
            const hRect = entry.hoverHost ? entry.hoverHost.getBoundingClientRect() : mRect;

            const inMedia = this._pointInRect(x, y, mRect);
            const inHost = this._pointInRect(x, y, hRect);

            if (inMedia || inHost) {
                const belongs = hits.some(el => {
                    if (el === media || media.contains(el)) return true;
                    if (entry.hoverHost && (el === entry.hoverHost || entry.hoverHost.contains(el))) return true;
                    const card = media.closest('a[href*="/reel"], a[href*="/reels"], div[data-pagelet*="Reel"], div[role="article"], div[role="listitem"], div[data-pagelet*="FeedUnit"], div.x1y1aw1k');
                    if (card && (el === card || card.contains(el))) return true;
                    return false;
                });
                if (belongs && !matchedCandidates.includes(candidate)) {
                    matchedCandidates.push(candidate);
                }
            }
        }

        if (matchedCandidates.length > 0) {
            // Find candidate that directly contains the cursor (so sibling cards in carousels never steal hover)
            let best = null;
            for (const c of matchedCandidates) {
                const mr = c.media.getBoundingClientRect();
                if (this._pointInRect(x, y, mr)) {
                    if (!best || (c.media.tagName.toLowerCase() === 'video' && best.media.tagName.toLowerCase() !== 'video')) {
                        best = c;
                    }
                }
            }
            if (!best) {
                best = matchedCandidates[0];
            }
            this._show(best.entry);
            return;
        }

        // If no candidate was actually hit by elementsFromPoint (e.g. hovering on dialog background / comments),
        // hide any active overlay rather than guessing incorrectly.
        this._scheduleHide();
    }

    _show(entry) {
        clearTimeout(this.hideTimeout);

        // Strict Single-Overlay Enforcement:
        // Hide and disable pointer-events on ALL other overlays to prevent any double-button overlaps!
        for (const other of this.overlays.values()) {
            if (other !== entry) {
                this._hide(other);
            }
        }

        // Spatial Deduplication & Ghost/Foreign Overlay Cleanup:
        // Automatically purge any duplicate, foreign, or overlapping .magic-dl-overlay in the DOM
        // within 35px to prevent blurry / ghosted double-button rendering!
        const cRect = entry.container.getBoundingClientRect();
        const cTop = parseInt(entry.container.style.top || '0', 10);
        const cLeft = parseInt(entry.container.style.left || '0', 10);

        const allOverlays = document.querySelectorAll('.magic-dl-overlay');
        for (const ov of allOverlays) {
            if (ov === entry.container) continue;
            // Purge foreign overlay without our specialized marker
            if (!ov.hasAttribute('data-toystaller-fb')) {
                ov.remove();
                continue;
            }
            // Purge any duplicate overlay sitting at the exact same location (rendered or style coordinates)
            const oTop = parseInt(ov.style.top || '0', 10);
            const oLeft = parseInt(ov.style.left || '0', 10);
            const oRect = ov.getBoundingClientRect();

            const isDuplicatePos = (cTop > 0 && Math.abs(oTop - cTop) < 35 && Math.abs(oLeft - cLeft) < 35) ||
                                   (oRect.width > 0 && cRect.width > 0 && Math.abs(oRect.top - cRect.top) < 35 && Math.abs(oLeft - cLeft) < 35);

            if (isDuplicatePos) {
                ov.remove();
            }
        }

        const platform = this._getPlatform();
        const inModal = platform && platform.isInsideModal ? platform.isInsideModal(entry.media) : false;
        entry.container.style.zIndex = inModal ? '2500' : '150';

        entry.container.style.display = 'flex';
        entry.container.style.opacity = '1';
        entry.container.style.visibility = 'visible';
        entry.container.style.pointerEvents = 'auto';
        this.activeEntry = entry;
    }

    _hide(entry) {
        if (!entry || !entry.container) return;
        entry.container.style.opacity = '0';
        entry.container.style.visibility = 'hidden';
        entry.container.style.pointerEvents = 'none';
        entry.container.style.display = 'none';
    }

    _scheduleHide() {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = setTimeout(() => {
            for (const entry of this.overlays.values()) {
                this._hide(entry);
            }
            this.activeEntry = null;
        }, 250);
    }

    _getMediaResolution(media) {
        if (!media) return 0;
        if (media.tagName.toLowerCase() === 'video') {
            const w = media.videoWidth || media.offsetWidth || 0;
            const h = media.videoHeight || media.offsetHeight || 0;
            return w * h;
        }
        const w = media.naturalWidth || media.width || media.offsetWidth || 0;
        const h = media.naturalHeight || media.height || media.offsetHeight || 0;
        return w * h;
    }

    _rectsOverlap(r1, r2, threshold = 0.45) {
        if (!r1 || !r2 || r1.width <= 0 || r1.height <= 0 || r2.width <= 0 || r2.height <= 0) return false;
        const intersectL = Math.max(r1.left, r2.left);
        const intersectT = Math.max(r1.top, r2.top);
        const intersectR = Math.min(r1.right, r2.right);
        const intersectB = Math.min(r1.bottom, r2.bottom);
        const iW = Math.max(0, intersectR - intersectL);
        const iH = Math.max(0, intersectB - intersectT);
        const iArea = iW * iH;
        const a1 = r1.width * r1.height;
        const a2 = r2.width * r2.height;
        return (iArea / a1 > threshold || iArea / a2 > threshold);
    }

    _destroyEntry(media) {
        const entry = this.overlays.get(media);
        if (!entry) return;
        if (entry.resizeObserver) entry.resizeObserver.disconnect();
        if (entry.intersectionObserver) entry.intersectionObserver.disconnect();
        if (entry.container && entry.container.parentNode) {
            entry.container.remove();
        }
        if (this.activeEntry === entry) this.activeEntry = null;
        this.overlays.delete(media);
    }

    hasOverlay(media) {
        if (!media) return false;
        if (this.overlays.has(media)) return true;
        const mediaTag = media.tagName.toLowerCase();
        const hoverHost = this._findHoverHost(media);
        const mRect = media.getBoundingClientRect();

        for (const [existingMedia, existingEntry] of this.overlays.entries()) {
            if (existingMedia === media) return true;
            const existingTag = existingMedia.tagName.toLowerCase();

            // If existing is a visible video and new is an img in the same space, existing video wins!
            if (existingTag === 'video' && mediaTag !== 'video') {
                const eRect = existingMedia.getBoundingClientRect();
                if (eRect.width >= 100 && this._rectsOverlap(mRect, eRect, 0.4)) {
                    return true;
                }
            }

            if (hoverHost && existingEntry.hoverHost && hoverHost === existingEntry.hoverHost && hoverHost !== media && hoverHost !== existingMedia) {
                // If it's a shared parent in a collage or grid, only treat as duplicate if bounding boxes overlap
                const eRect = existingMedia.getBoundingClientRect();
                if (Math.abs(mRect.top - eRect.top) < 20 && Math.abs(mRect.left - eRect.left) < 20) {
                    return true;
                }
            }
            if (existingMedia.contains(media) || (media.contains && media.contains(existingMedia))) return true;
        }
        return false;
    }

    addOverlay(media, createButtonsFn) {
        if (this.overlays.has(media)) return;

        const hoverHost = this._findHoverHost(media);

        // Deduplication: prevent multiple overlays on the same photo tile or overlapping elements
        const mRect = media.getBoundingClientRect();
        for (const [existingMedia, existingEntry] of this.overlays.entries()) {
            if (existingMedia === media) return;

            // If one is video and one is img, video ALWAYS wins!
            const isThisVideo = media.tagName.toLowerCase() === 'video';
            const isExistingVideo = existingMedia.tagName.toLowerCase() === 'video';
            if (!isThisVideo && isExistingVideo) {
                const eRect = existingMedia.getBoundingClientRect();
                if (eRect.width >= 100 && this._rectsOverlap(mRect, eRect, 0.4)) {
                    return; // Video already has overlay!
                }
            } else if (isThisVideo && !isExistingVideo) {
                const eRect = existingMedia.getBoundingClientRect();
                if (this._rectsOverlap(mRect, eRect, 0.4)) {
                    this._destroyEntry(existingMedia);
                    break;
                }
            }

            // 1. Shared hoverHost tile deduplication (e.g. blur placeholder + sharp photo inside same tile)
            if (hoverHost && existingEntry.hoverHost && hoverHost === existingEntry.hoverHost) {
                const mRes = this._getMediaResolution(media);
                const eRes = this._getMediaResolution(existingMedia);
                if (mRes > eRes && mRes > 20000) {
                    this._destroyEntry(existingMedia);
                    break;
                } else {
                    return; // Existing overlay is already on the tile!
                }
            }

            // 2. Ancestor/child containment deduplication
            if (existingMedia.contains(media) || media.contains(existingMedia)) {
                return;
            }

            // 3. Spatial bounding box overlap deduplication
            if (mRect.width > 0 && mRect.height > 0) {
                const eRect = existingMedia.getBoundingClientRect();
                if (this._rectsOverlap(mRect, eRect, 0.5)) {
                    const mRes = this._getMediaResolution(media);
                    const eRes = this._getMediaResolution(existingMedia);
                    if (mRes > eRes) {
                        this._destroyEntry(existingMedia);
                        break;
                    } else {
                        return;
                    }
                }
            }
        }

        const platform = this._getPlatform();
        const hasModal = platform && platform.hasActiveModal ? platform.hasActiveModal() : false;
        if (hasModal && platform && platform.isInsideModal && !platform.isInsideModal(media)) {
            return;
        }

        const container = document.createElement('div');
        container.className = 'magic-dl-overlay';
        container.setAttribute('data-toystaller-fb', 'true');
        container.style.cssText = `
            position: fixed;
            z-index: 150;
            display: flex;
            gap: 6px;
            pointer-events: none;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.15s ease, visibility 0.15s ease;
        `;

        const buttons = createButtonsFn();
        buttons.forEach(btn => {
            btn.addEventListener('mouseenter', () => this._show(this.overlays.get(media)));
            container.appendChild(btn);
        });

        document.body.appendChild(container);
        const hostShow = () => {
            const entry = this.overlays.get(media);
            if (entry) {
                const curPlatform = this._getPlatform();
                const curModal = curPlatform && curPlatform.hasActiveModal ? curPlatform.hasActiveModal() : false;
                const curMenu = curPlatform && curPlatform.hasActiveMenu ? curPlatform.hasActiveMenu() : false;
                const curNonTheater = curPlatform && curPlatform.hasActiveNonTheaterModal ? curPlatform.hasActiveNonTheaterModal() : false;
                if (curMenu || curNonTheater) return;
                if (curModal && curPlatform && curPlatform.isInsideModal && !curPlatform.isInsideModal(media)) {
                    return;
                }
                if (this._isClippedByAncestor(media)) return;
                this._show(entry);
            }
        };
        const hostHide = () => this._scheduleHide();

        hoverHost.addEventListener('mouseenter', hostShow, true);
        hoverHost.addEventListener('mouseleave', hostHide, true);

        const resizeObserver = new ResizeObserver(() => {
            this.updatePosition(media, container);
        });
        resizeObserver.observe(media);
        if (hoverHost !== media) {
            resizeObserver.observe(hoverHost);
        }

        const entry = { container, corner: null, resizeObserver, hoverHost, isVisible: true, intersectionObserver: null, media };
        
        entry.intersectionObserver = new IntersectionObserver((entries) => {
            for (const e of entries) {
                entry.isVisible = e.isIntersecting;
                this.updatePosition(media, container);
            }
        }, { threshold: 0.15 });
        
        entry.intersectionObserver.observe(media);

        this.overlays.set(media, entry);

        requestAnimationFrame(() => this.updatePosition(media, container));
    }

    isSiteControl(el, media) {
        if (!el || el === document.documentElement || el === document.body) return false;
        if (el.closest('.magic-dl-overlay')) return false;
        // Never consider the media element, its descendants, or its ancestors (like photo link/button wrappers) as conflicting site controls
        if (el === media || media.contains(el) || el.contains(media)) return false;

        const entry = this.overlays.get(media);
        if (entry && (el === entry.hoverHost || entry.hoverHost.contains(el) || el.contains(entry.hoverHost))) return false;

        const tag = el.tagName.toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const className = (el.className && typeof el.className === 'string')
            ? el.className.toLowerCase()
            : '';

        const controlHints = ['close', 'dismiss', 'minimize', 'expand', 'fullscreen', 'menu', 'more', 'options', 'share',
                               'mute', 'unmute', 'volume', 'sound', 'play', 'pause', 'like', 'comment', 'follow',
                               'audio', 'speaker', 'forward', 'rewind', 'skip', 'next', 'previous', 'seek'];
        const hintText = `${ariaLabel} ${title} ${className}`;
        if (controlHints.some(hint => hintText.includes(hint))) return true;

        if (['button', 'input', 'select', 'textarea'].includes(tag)) return true;
        if (role === 'button' || role === 'menuitem') return true;
        if (el.closest('button, [role="button"], [role="menuitem"]')) return true;

        const style = window.getComputedStyle(el);
        if (style.pointerEvents !== 'none' && parseInt(style.zIndex, 10) > 5000) return true;

        return false;
    }

    getPlatformConfig(media) {
        const platform = this._getPlatform();
        if (platform && platform.getPlatformConfig) {
            return platform.getPlatformConfig(window.location.pathname.toLowerCase(), media);
        }
        return { preferredCorners: ['top-right', 'bottom-right'], padding: 12 };
    }

    cornerHasConflict(media, rect, corner, width, height, pad = 12) {
        const config = this.getPlatformConfig(media);
        const topOffset = config.topOffset || 0;
        let x;
        let y;

        switch (corner) {
            case 'bottom-right':
                x = rect.right - pad - width / 2;
                y = rect.bottom - pad - height / 2;
                break;
            case 'bottom-left':
                x = rect.left + pad + width / 2;
                y = rect.bottom - pad - height / 2;
                break;
            case 'top-left':
                x = rect.left + pad + width / 2;
                y = rect.top + pad + topOffset + height / 2;
                break;
            case 'top-right':
                x = rect.right - pad - width / 2;
                y = rect.top + pad + topOffset + height / 2;
                break;
            case 'top-center':
                x = rect.left + rect.width / 2;
                y = rect.top + pad + topOffset + height / 2;
                break;
            case 'bottom-center':
                x = rect.left + rect.width / 2;
                y = rect.bottom - pad - height / 2;
                break;
            default:
                return true;
        }

        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
            return true;
        }

        const hits = document.elementsFromPoint(x, y);
        for (const el of hits) {
            if (this.isSiteControl(el, media)) return true;
        }
        return false;
    }

    pickBestCorner(media, rect, container) {
        const width = container.offsetWidth || 80;
        const height = container.offsetHeight || 36;
        const config = this.getPlatformConfig(media);

        const corners = [...config.preferredCorners];

        for (const corner of corners) {
            if (!this.cornerHasConflict(media, rect, corner, width, height, config.padding)) {
                return corner;
            }
        }

        return corners[0] || 'top-right';
    }

    // Compute the actually visible portion of a media element by intersecting
    // its rect with all overflow-clipping ancestors and the viewport.
    _getVisibleRect(media) {
        let vRect = media.getBoundingClientRect();
        let visTop = vRect.top;
        let visLeft = vRect.left;
        let visBottom = vRect.bottom;
        let visRight = vRect.right;

        let node = media.parentElement;
        let depth = 0;
        while (node && node !== document.body && node !== document.documentElement && depth < 15) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const style = window.getComputedStyle(node);
                const ov = style.overflow + style.overflowX + style.overflowY;
                if (ov.includes('hidden') || ov.includes('scroll') || ov.includes('auto') || ov.includes('clip')) {
                    const pRect = node.getBoundingClientRect();
                    visTop = Math.max(visTop, pRect.top);
                    visLeft = Math.max(visLeft, pRect.left);
                    visBottom = Math.min(visBottom, pRect.bottom);
                    visRight = Math.min(visRight, pRect.right);
                }
            }
            node = node.parentElement;
            depth++;
        }

        const platform = this._getPlatform();
        const inModal = platform && platform.isInsideModal ? platform.isInsideModal(media) : false;
        const topLimit = inModal ? 0 : this._getTopNavHeight();

        // Also clamp to viewport & sticky top nav
        visTop = Math.max(visTop, topLimit);
        visLeft = Math.max(visLeft, 0);
        visBottom = Math.min(visBottom, window.innerHeight);
        visRight = Math.min(visRight, window.innerWidth);

        return {
            top: visTop,
            left: visLeft,
            bottom: visBottom,
            right: visRight,
            width: Math.max(0, visRight - visLeft),
            height: Math.max(0, visBottom - visTop)
        };
    }

    applyCornerPosition(rect, container, corner, media) {
        const config = this.getPlatformConfig(media);
        const pad = config.padding;
        const topOffset = config.topOffset || 0;
        const width = container.offsetWidth || 80;
        const height = container.offsetHeight || 36;

        let top, left;

        switch (corner) {
            case 'bottom-right':
                top = rect.bottom - height - pad;
                left = rect.right - width - pad;
                break;
            case 'bottom-left':
                top = rect.bottom - height - pad;
                left = rect.left + pad;
                break;
            case 'top-left':
                top = rect.top + pad + topOffset;
                left = rect.left + pad;
                break;
            case 'top-right':
                top = rect.top + pad + topOffset;
                left = rect.right - width - pad;
                break;
            case 'top-center':
                top = rect.top + pad + topOffset;
                left = rect.left + (rect.width - width) / 2;
                break;
            case 'bottom-center':
                top = rect.bottom - height - pad;
                left = rect.left + (rect.width - width) / 2;
                break;
            default:
                top = rect.top + pad + topOffset;
                left = rect.right - width - pad;
        }

        const platform = this._getPlatform();
        const section = platform && platform.getSection ? platform.getSection() : 'feed';
        const inModal = platform && platform.isInsideModal ? platform.isInsideModal(media) : false;
        const isReel = section === 'reels' || (config.preferredCorners && config.preferredCorners[0] === 'top-right' && config.topOffset);
        const isImmersive = inModal || isReel || section === 'stories';
        const topNavHeight = isImmersive ? 0 : this._getTopNavHeight();

        // 1. Strict Top Boundary:
        // As media scrolls, keep button locked in place! When its corner reaches the top navbar,
        // HIDE it gracefully — NEVER dynamically jump down to bottom-right!
        if (!isImmersive) {
            if (top < topNavHeight + 4 || rect.top < topNavHeight - 8 || rect.bottom <= topNavHeight + 12) {
                container.style.display = 'none';
                container.style.visibility = 'hidden';
                return;
            }
        } else {
            if (top < 4) {
                container.style.display = 'none';
                container.style.visibility = 'hidden';
                return;
            }
        }

        // 2. Viewport Boundaries:
        if (top + height > window.innerHeight - 4 || left < 2 || left + width > window.innerWidth - 2) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            return;
        }

        // 3. Overflow container / ancestor clipping:
        const vis = media ? this._getVisibleRect(media) : rect;
        if (top < vis.top - 2 || top + height > vis.bottom + 2 || left < vis.left - 2 || left + width > vis.right + 2) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            return;
        }

        container.style.top = `${top}px`;
        container.style.left = `${left}px`;
    }

    updatePosition(media, container) {
        const entry = this.overlays.get(media);
        if (!entry) return;

        if (!media.isConnected) {
            entry.resizeObserver.disconnect();
            if (entry.intersectionObserver) entry.intersectionObserver.disconnect();
            container.remove();
            if (this.activeEntry === entry) this.activeEntry = null;
            this.overlays.delete(media);
            return;
        }

        const platform = this._getPlatform();
        const hasModal = platform && platform.hasActiveModal ? platform.hasActiveModal() : false;
        const hasMenu = platform && platform.hasActiveMenu ? platform.hasActiveMenu() : false;
        const hasNonTheaterModal = platform && platform.hasActiveNonTheaterModal ? platform.hasActiveNonTheaterModal() : false;

        // Modal or Menu isolation check: eliminate bleed-through behind menus and non-theater dialogs
        if (hasMenu || hasNonTheaterModal || (hasModal && platform && platform.isInsideModal && !platform.isInsideModal(media))) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            container.style.pointerEvents = 'none';
            if (this.activeEntry === entry) this.activeEntry = null;
            return;
        }

        // Per-section toggle check
        if (this._isSectionDisabledByToggle()) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            container.style.pointerEvents = 'none';
            if (this.activeEntry === entry) this.activeEntry = null;
            return;
        }

        // Section thumbnail/eligibility check
        if (platform && platform.isThumbnail && platform.isThumbnail(media)) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            container.style.pointerEvents = 'none';
            if (this.activeEntry === entry) this.activeEntry = null;
            return;
        }

        const rect = media.getBoundingClientRect();
        const style = window.getComputedStyle(media);
        const isStyleHidden = style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none';

        const inModal = platform && platform.isInsideModal ? platform.isInsideModal(media) : false;
        const topNavHeight = inModal ? 0 : this._getTopNavHeight();

        // If media has scrolled behind top navbar or off screen
        if (rect.bottom <= topNavHeight + 12 || (!inModal && rect.top < topNavHeight - 8)) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            container.style.pointerEvents = 'none';
            if (this.activeEntry === entry) this.activeEntry = null;
            return;
        }

        const vis = this._getVisibleRect(media);
        if (vis.height < 45 || vis.width < 50) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            container.style.pointerEvents = 'none';
            if (this.activeEntry === entry) this.activeEntry = null;
            return;
        }

        if (rect.width === 0 || rect.height === 0 || !entry.isVisible || isStyleHidden || this._isClippedByAncestor(media)) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            container.style.pointerEvents = 'none';
            return;
        }

        const fullyAbove = rect.bottom < 0;
        const fullyBelow = rect.top > window.innerHeight;
        const fullyLeft = rect.right < 0;
        const fullyRight = rect.left > window.innerWidth;

        if (fullyAbove || fullyBelow || fullyLeft || fullyRight) {
            container.style.display = 'none';
            container.style.visibility = 'hidden';
            container.style.pointerEvents = 'none';
            return;
        }

        container.style.display = 'flex';
        if (this.activeEntry === entry) {
            container.style.visibility = 'visible';
            container.style.opacity = '1';
            container.style.pointerEvents = 'auto';
        }

        // Lock corner on first placement so buttons never jump down across corners on scroll!
        if (!entry.corner) {
            entry.corner = this.pickBestCorner(media, rect, container);
        }
        this.applyCornerPosition(rect, container, entry.corner, media);
    }

    updateAllPositions() {
        const platform = this._getPlatform();
        const hasModal = platform && platform.hasActiveModal ? platform.hasActiveModal() : false;

        // If an active modal is open and the activeEntry is outside the modal, instantly reset it
        if (hasModal && this.activeEntry && platform && platform.isInsideModal && !platform.isInsideModal(this.activeEntry.hoverHost)) {
            this._hide(this.activeEntry);
            this.activeEntry = null;
        }

        for (const [media, entry] of this.overlays.entries()) {
            this.updatePosition(media, entry.container);
        }
    }
}

window.magicOverlayManager = new OverlayManager();

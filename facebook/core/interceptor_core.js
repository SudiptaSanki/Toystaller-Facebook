// page_interceptor.js
// Runs in the main page context.
// Intercepts fetch/XHR network streams, tracks video IDs in Relay/GraphQL responses,
// monitors URL changes (Reels scrolling), and traverses React Fiber trees up through parent
// components to extract master HD video URLs (playable_url_quality_hd, browser_native_hd_url).

(function () {
    'use strict';
    if (window.__toystallerInterceptorLoaded) return;
    window.__toystallerInterceptorLoaded = true;

    // --- Video Store by Video ID & MRU History ---
    // Maps videoId -> { id, hd, sd, dashVideo, dashVideoBitrate, dashAudio, dashAudioBitrate, allUrls: Set, timestamp }
    const videoStoreById = new Map();
    const recentVideosMRU = []; // Ordered list of videoIds, most recent first (max 50)
    const recentUrlsPool = []; // Recent valid video URLs regardless of ID (max 50)

    function parseStreamMetadata(url) {
        if (!url || typeof url !== 'string') return null;
        let videoId = null;
        let vencodeTag = '';
        let bitrate = 0;
        try {
            const m = url.match(/[?&]efg=([^&]+)/);
            if (m) {
                let b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
                while (b64.length % 4) b64 += '=';
                const decoded = JSON.parse(atob(b64));
                if (decoded) {
                    if (decoded.video_id) videoId = String(decoded.video_id).trim();
                    if (decoded.vencode_tag) vencodeTag = String(decoded.vencode_tag).toLowerCase();
                    if (decoded.bitrate) bitrate = Number(decoded.bitrate) || 0;
                }
            }
        } catch(e) {}

        const lower = url.toLowerCase();
        const isAudio = vencodeTag.includes('audio') || 
                        vencodeTag.includes('dash_a') || 
                        lower.includes('dash_audio') || 
                        lower.includes('_audio_') || 
                        (bitrate > 0 && bitrate < 200000 && !vencodeTag.includes('baseline') && !vencodeTag.includes('video'));

        const isVideo = !isAudio && (
            vencodeTag.includes('baseline') || 
            vencodeTag.includes('video') || 
            vencodeTag.includes('dash_v') || 
            bitrate >= 200000 || 
            lower.includes('.mp4') || 
            lower.includes('.m4v')
        );

        return { videoId, vencodeTag, bitrate, isAudio, isVideo };
    }

    function recordVideoEntry(videoId, hdUrl, sdUrl, extraUrl) {
        if (!videoId && !hdUrl && !sdUrl && !extraUrl) return;

        let detectedId = videoId ? String(videoId).trim() : null;
        let parsed = extraUrl ? parseStreamMetadata(extraUrl) : null;
        if (!detectedId && parsed && parsed.videoId) {
            detectedId = parsed.videoId;
        }

        const id = detectedId;

        let entry = id ? videoStoreById.get(id) : null;
        if (!entry) {
            entry = { 
                id: id, 
                hd: null, 
                sd: null, 
                dashVideo: null, 
                dashVideoBitrate: 0, 
                dashAudio: null, 
                dashAudioBitrate: 0, 
                allUrls: new Set(), 
                timestamp: Date.now() 
            };
            if (id) {
                videoStoreById.set(id, entry);
                const idx = recentVideosMRU.indexOf(id);
                if (idx !== -1) recentVideosMRU.splice(idx, 1);
                recentVideosMRU.unshift(id);
                if (recentVideosMRU.length > 50) {
                    const removed = recentVideosMRU.pop();
                    videoStoreById.delete(removed);
                }
            }
        }

        entry.timestamp = Date.now();

        if (hdUrl && isValidVideo(hdUrl)) {
            entry.hd = hdUrl;
            entry.allUrls.add(hdUrl);
        }
        if (sdUrl && isValidVideo(sdUrl)) {
            entry.sd = sdUrl;
            entry.allUrls.add(sdUrl);
        }

        if (extraUrl) {
            if (!parsed) parsed = parseStreamMetadata(extraUrl);
            if (parsed && parsed.isAudio) {
                if (!entry.dashAudio || (parsed.bitrate && parsed.bitrate > entry.dashAudioBitrate)) {
                    entry.dashAudio = extraUrl;
                    entry.dashAudioBitrate = parsed.bitrate;
                }
            } else if (isValidVideo(extraUrl)) {
                entry.allUrls.add(extraUrl);
                if (!parsed || parsed.isVideo) {
                    const br = parsed ? parsed.bitrate : 0;
                    if (!entry.dashVideo || br > entry.dashVideoBitrate) {
                        entry.dashVideo = extraUrl;
                        entry.dashVideoBitrate = br;
                    }
                }
            }
        }

        const bestVideo = entry.hd || entry.dashVideo || entry.sd;
        if (bestVideo && isValidVideo(bestVideo)) {
            const idx = recentUrlsPool.indexOf(bestVideo);
            if (idx !== -1) recentUrlsPool.splice(idx, 1);
            recentUrlsPool.unshift(bestVideo);
            if (recentUrlsPool.length > 50) recentUrlsPool.pop();
        }
    }

    // --- Monkey-patch history pushState / replaceState for Instant Reel Navigation Detection ---
    try {
        const originalPushState = history.pushState;
        history.pushState = function (...args) {
            const res = originalPushState.apply(this, args);
            window.postMessage({ type: 'toystaller_url_changed', url: window.location.href }, '*');
            return res;
        };
        const originalReplaceState = history.replaceState;
        history.replaceState = function (...args) {
            const res = originalReplaceState.apply(this, args);
            window.postMessage({ type: 'toystaller_url_changed', url: window.location.href }, '*');
            return res;
        };
        window.addEventListener('popstate', () => {
            window.postMessage({ type: 'toystaller_url_changed', url: window.location.href }, '*');
        });
    } catch (e) {}

    const getPlatform = () => {
        return window.ToystallerPlatforms['facebook'] || window.ToystallerPlatform || {
            name: 'facebook',
            isValidVideo(url) {
                if (!url || typeof url !== 'string') return false;
                const lower = url.toLowerCase();
                if (lower.startsWith('blob:') || lower.startsWith('data:')) return false;
                if (lower.includes('facebook.com') || lower.includes('messenger.com')) return false;
                if (lower.includes('unified_cvc') || lower.includes('bytestart') || lower.includes('byteend')) return false;
                const isCdn = lower.includes('fbcdn.net') || lower.includes('fbsbx.com');
                const isVideoExt = lower.includes('.mp4') || lower.includes('.m4v') || lower.includes('.webm');
                return (isCdn || isVideoExt) && !lower.includes('scontent') && !lower.includes('.jpg') && !lower.includes('.png');
            },
            shouldSkipReactValue(val) {
                const lower = (val || '').toLowerCase();
                return lower.includes('facebook.com') || lower.includes('unified_cvc');
            },
            looksLikeReactVideo(val) {
                return this.isValidVideo(val);
            },
            looksLikeReactImage(val, key) {
                const lowerKey = (key || '').toLowerCase();
                const lowerVal = (val || '').toLowerCase();
                return (lowerKey.includes('image') || lowerVal.includes('scontent')) && !lowerVal.includes('.mp4');
            },
            extractPriorityReactUrl() { return null; },
            extractVideoUrlFromDOM() { return null; }
        };
    };

    function isValidVideo(url) {
        const platform = getPlatform();
        return platform.isValidVideo ? platform.isValidVideo(url) : true;
    }

    function cleanVideoUrl(url) {
        if (!url || typeof url !== 'string') return null;
        let clean = url;
        clean = clean.replace(/\\\//g, '/');
        clean = clean.replace(/&amp;/g, '&')
                     .replace(/\\u0026/g, '&')
                     .replace(/\u0026/g, '&')
                     .replace(/\\u002526/g, '&');
        clean = clean.replace(/([?&])bytestart=\d+&?/g, '$1')
                     .replace(/([?&])byteend=\d+&?/g, '$1');
        clean = clean.replace(/[?&]$/, '');
        return clean.trim().replace(/^["']|["']$/g, '');
    }

    // --- Parse JSON / Relay Chunks with Video ID Association ---
    function extractUrlsFromText(text) {
        if (!text || (!text.includes('fbcdn.net') && !text.includes('fbsbx.com') && !text.includes('playable_url') && !text.includes('browser_native_hd_url'))) return;

        let clean = text;
        if (clean.startsWith('for (;;);')) {
            clean = clean.substring(9);
        }

        const foundUrls = new Set();

        // 1. Regex search for video ID & HD / SD URLs in proximity
        // Looks for JSON patterns like: "video_id":"123...", "playable_url_quality_hd":"..."
        const chunkRegex = /"(?:video_id|fbid|id)"\s*:\s*"?(\d{10,25})"?[\s\S]{1,1200}?"(playable_url_quality_hd|browser_native_hd_url|hd_src|playable_url|browser_native_sd_url|sd_src)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
        let cm;
        while ((cm = chunkRegex.exec(clean)) !== null) {
            const vid = cm[1];
            const key = cm[2];
            try {
                const rawUrl = JSON.parse('"' + cm[3] + '"');
                const u = cleanVideoUrl(rawUrl);
                if (u && isValidVideo(u)) {
                    foundUrls.add(u);
                    if (key.includes('hd')) {
                        recordVideoEntry(vid, u, null, u);
                    } else {
                        recordVideoEntry(vid, null, u, u);
                    }
                }
            } catch (err) {}
        }

        // 2. Direct named key scan: playable_url_quality_hd, browser_native_hd_url, etc.
        const videoRegex = /"(playable_url_quality_hd|browser_native_hd_url|hd_src|playable_url|browser_native_sd_url|sd_src|progressive_download_url)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
        let m;
        while ((m = videoRegex.exec(clean)) !== null) {
            const key = m[1];
            try {
                const rawUrl = JSON.parse('"' + m[2] + '"');
                const u = cleanVideoUrl(rawUrl);
                if (u && isValidVideo(u)) {
                    foundUrls.add(u);
                    if (key.includes('hd')) {
                        recordVideoEntry(null, u, null, u);
                    } else {
                        recordVideoEntry(null, null, u, u);
                    }
                }
            } catch (err) {}
        }

        // 3. Fallback scan for any CDN MP4 / M4V URL
        const cdnRegex = /"(https:(?:\\\/\\\/|\/\/)[^"]+?(?:fbcdn\.net|fbsbx\.com)[^"]+?\.(?:mp4|m4v)[^"]*)"/g;
        let cdnM;
        while ((cdnM = cdnRegex.exec(clean)) !== null) {
            try {
                const url = cleanVideoUrl(JSON.parse('"' + cdnM[1] + '"'));
                if (url) {
                    const meta = parseStreamMetadata(url);
                    if (meta && meta.isAudio) {
                        recordVideoEntry(meta.videoId, null, null, url);
                    } else if (isValidVideo(url)) {
                        foundUrls.add(url);
                        recordVideoEntry(meta ? meta.videoId : null, null, null, url);
                    }
                }
            } catch(e) {
                const unescaped = cleanVideoUrl(cdnM[1]);
                if (unescaped) {
                    const meta = parseStreamMetadata(unescaped);
                    if (meta && meta.isAudio) {
                        recordVideoEntry(meta.videoId, null, null, unescaped);
                    } else if (isValidVideo(unescaped)) {
                        foundUrls.add(unescaped);
                        recordVideoEntry(meta ? meta.videoId : null, null, null, unescaped);
                    }
                }
            }
        }

        // Dispatch found URLs to content script
        if (foundUrls.size > 0) {
            window.postMessage({
                type: 'toystaller_video_urls',
                urls: Array.from(foundUrls)
            }, '*');
        }
    }

    // --- Network Interception: Fetch ---
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            if (
                url.includes('facebook.com') ||
                url.includes('fbcdn.net') ||
                url.includes('graph.') ||
                url.includes('/api/graphql') ||
                url.includes('/ajax/') ||
                url.includes('graphql')
            ) {
                const clone = response.clone();
                clone.text().then(extractUrlsFromText).catch(() => {});
            }
        } catch (e) {}
        return response;
    };

    // --- Network Interception: XMLHttpRequest ---
    const OriginalXHR = window.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open.bind(xhr);
        let reqUrl = '';
        xhr.open = function (method, url, ...rest) {
            reqUrl = url || '';
            return originalOpen(method, url, ...rest);
        };
        xhr.addEventListener('load', function () {
            try {
                if (
                    reqUrl.includes('facebook.com') ||
                    reqUrl.includes('fbcdn.net') ||
                    reqUrl.includes('/api/graphql') ||
                    reqUrl.includes('/ajax/') ||
                    reqUrl.includes('graphql')
                ) {
                    extractUrlsFromText(this.responseText);
                }
            } catch (e) {}
        });
        return xhr;
    }
    PatchedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;

    // --- Initial and Dynamic Script Scanning ---
    function scanAllScripts() {
        const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
        for (const s of scripts) {
            const content = s.textContent;
            if (content && (content.includes('fbcdn.net') || content.includes('playable_url') || content.includes('browser_native_hd_url'))) {
                extractUrlsFromText(content);
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanAllScripts);
    } else {
        scanAllScripts();
    }

    try {
        const scriptObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.tagName === 'SCRIPT' && node.textContent) {
                        extractUrlsFromText(node.textContent);
                    }
                }
            }
        });
        if (document.documentElement) {
            scriptObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
    } catch(e) {}

    // --- Deep React Fiber Traversal with Parent (return) Walk ---
    // Specifically inspects component props to extract master HD stream before SD.
    function inspectFiberProps(obj, seen = new Set(), depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 8) return { hd: null, sd: null, id: null };
        if (seen.has(obj)) return { hd: null, sd: null, id: null };
        seen.add(obj);

        let res = { hd: null, sd: null, id: null };

        // 1. Check for Video ID
        if (obj.id && typeof obj.id === 'string' && /^\d{10,25}$/.test(obj.id)) {
            res.id = obj.id;
        } else if (obj.video_id && typeof obj.video_id === 'string' && /^\d{10,25}$/.test(obj.video_id)) {
            res.id = obj.video_id;
        } else if (obj.videoId && typeof obj.videoId === 'string' && /^\d{10,25}$/.test(obj.videoId)) {
            res.id = obj.videoId;
        }

        // 2. Priority HD properties
        const hdCandidates = [
            obj.playable_url_quality_hd,
            obj.browser_native_hd_url,
            obj.hd_src,
            obj.hd_src_no_ratelimit,
            obj.progressive_download_url
        ];
        for (const c of hdCandidates) {
            if (typeof c === 'string') {
                const clean = cleanVideoUrl(c);
                if (clean && isValidVideo(clean)) {
                    res.hd = clean;
                    return res; // Found master HD!
                }
            }
        }

        // 3. Multi-version video array (video_versions)
        if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
            const sorted = [...obj.video_versions].sort((a, b) => {
                const resA = (a.width || 0) * (a.height || 0);
                const resB = (b.width || 0) * (b.height || 0);
                return resB - resA;
            });
            for (const v of sorted) {
                if (v && typeof v.url === 'string') {
                    const clean = cleanVideoUrl(v.url);
                    if (clean && isValidVideo(clean)) {
                        res.hd = clean;
                        return res;
                    }
                }
            }
        }

        // 4. SD properties
        const sdCandidates = [
            obj.playable_url,
            obj.browser_native_sd_url,
            obj.sd_src,
            obj.sd_src_no_ratelimit,
            obj.playback_url,
            obj.progressiveUrl,
            obj.streamingUrl,
            obj.video_url,
            obj.videoUrl
        ];
        for (const c of sdCandidates) {
            if (typeof c === 'string') {
                const clean = cleanVideoUrl(c);
                if (clean && isValidVideo(clean)) {
                    res.sd = clean;
                }
            }
        }

        // 5. Recurse into nested objects
        const priorityKeys = ['video', 'media', 'creation_story', 'playbackData', 'videoData', 'feedUnit', 'attachment', 'reel'];
        for (const k of priorityKeys) {
            if (obj[k] && typeof obj[k] === 'object') {
                const child = inspectFiberProps(obj[k], seen, depth + 1);
                if (child.hd) { res.hd = child.hd; return res; }
                if (child.sd && !res.sd) res.sd = child.sd;
                if (child.id && !res.id) res.id = child.id;
            }
        }

        for (const k of Object.keys(obj)) {
            if (priorityKeys.includes(k) || k === 'return' || k === 'sibling' || k === 'child' || k === '_owner' || k === 'stateNode') continue;
            if (obj[k] && typeof obj[k] === 'object') {
                const child = inspectFiberProps(obj[k], seen, depth + 1);
                if (child.hd) { res.hd = child.hd; return res; }
                if (child.sd && !res.sd) res.sd = child.sd;
                if (child.id && !res.id) res.id = child.id;
            }
        }

        return res;
    }

    // Traverses the React Fiber hierarchy from the given DOM element up to 45 ancestor components.
    function extractVideoUrlFromFiberTree(el) {
        if (!el) return null;

        // Locate Fiber key
        const fiberKey = Object.keys(el).find(k =>
            k.startsWith('__reactFiber$') ||
            k.startsWith('__reactInternalInstance$')
        );
        let fiber = fiberKey ? el[fiberKey] : null;

        let bestHd = null;
        let bestSd = null;
        let detectedId = null;

        let depth = 0;
        while (fiber && depth < 45) {
            // Inspect props and state
            if (fiber.memoizedProps) {
                const p = inspectFiberProps(fiber.memoizedProps);
                if (p.hd) { bestHd = p.hd; break; }
                if (p.sd && !bestSd) bestSd = p.sd;
                if (p.id && !detectedId) detectedId = p.id;
            }
            if (fiber.memoizedState) {
                const s = inspectFiberProps(fiber.memoizedState);
                if (s.hd) { bestHd = s.hd; break; }
                if (s.sd && !bestSd) bestSd = s.sd;
                if (s.id && !detectedId) detectedId = s.id;
            }
            if (fiber.pendingProps) {
                const pp = inspectFiberProps(fiber.pendingProps);
                if (pp.hd) { bestHd = pp.hd; break; }
                if (pp.sd && !bestSd) bestSd = pp.sd;
                if (pp.id && !detectedId) detectedId = pp.id;
            }

            fiber = fiber.return;
            depth++;
        }

        if (bestHd) {
            if (detectedId) recordVideoEntry(detectedId, bestHd, bestSd, bestHd);
            return bestHd;
        }

        // If an ID was detected, check the video store for HD
        if (detectedId && videoStoreById.has(detectedId)) {
            const entry = videoStoreById.get(detectedId);
            if (entry.hd) return entry.hd;
        }

        if (bestSd) return bestSd;
        return null;
    }

    // Extract Photo URL from React Fiber
    function extractImageUrlFromReact(el) {
        const platform = getPlatform();
        let current = el;
        for (let i = 0; i < 10 && current; i++) {
            const key = Object.keys(current).find(k =>
                k.startsWith('__reactProps$') ||
                k.startsWith('__reactFiber$') ||
                k.startsWith('__reactInternalInstance$')
            );
            if (key && current[key]) {
                const obj = current[key];
                if (platform.extractPriorityReactUrl) {
                    const photoUrl = platform.extractPriorityReactUrl(obj, false);
                    if (photoUrl) return photoUrl;
                }
            }
            current = current.parentElement;
        }
        return null;
    }

    // --- Content Script Bridge via postMessage ---
    window.addEventListener('message', (e) => {
        if (!e.data || e.data.type !== 'magic_get_react_url' || !e.data.id) return;
        const reqId = e.data.id;
        const isVideo = e.data.isVideo !== undefined ? e.data.isVideo : true;
        const requestedVideoId = e.data.videoId ? String(e.data.videoId).trim() : null;
        let el = document.querySelector(`[data-magic-id="${reqId}"]`);
        if (!el && isVideo) {
            // Fallback: look for playing or visible video in viewport
            const videos = Array.from(document.querySelectorAll('video'));
            el = videos.find(v => !v.paused || v.currentTime > 0) || videos[0];
        }

        let url = null;
        let audioUrl = null;

        if (isVideo) {
            // 1. If videoId was provided, check the video store first
            if (requestedVideoId && videoStoreById.has(requestedVideoId)) {
                const entry = videoStoreById.get(requestedVideoId);
                if (entry.hd) {
                    url = entry.hd;
                } else if (entry.dashVideo) {
                    url = entry.dashVideo;
                    audioUrl = entry.dashAudio;
                } else if (entry.sd) {
                    url = entry.sd;
                }
            }

            // 2. Check current Reel ID from URL if on /reel/
            if (!url && window.location.pathname.includes('/reel/')) {
                const m = window.location.pathname.match(/\/reel\/(\d+)/);
                if (m && m[1] && videoStoreById.has(m[1])) {
                    const entry = videoStoreById.get(m[1]);
                    if (entry.hd) {
                        url = entry.hd;
                    } else if (entry.dashVideo) {
                        url = entry.dashVideo;
                        audioUrl = entry.dashAudio;
                    } else if (entry.sd) {
                        url = entry.sd;
                    }
                }
            }

            // 3. Walk the React Fiber component hierarchy
            if (!url && el) {
                url = extractVideoUrlFromFiberTree(el);
            }

            // 4. Platform DOM / Script lookup matched to Video ID
            if (!url && el) {
                const platform = getPlatform();
                if (platform.extractVideoUrlFromDOM) {
                    url = platform.extractVideoUrlFromDOM(el);
                }
            }

            // If we have a video URL, resolve companion audio track if present
            if (url && !audioUrl) {
                const meta = parseStreamMetadata(url);
                const vid = (meta && meta.videoId) || requestedVideoId;
                if (vid && videoStoreById.has(vid)) {
                    const entry = videoStoreById.get(vid);
                    if (entry.dashAudio) {
                        audioUrl = entry.dashAudio;
                    }
                }
            }
        } else {
            if (el) {
                url = extractImageUrlFromReact(el);
            }
        }

        // Guarantee audio-only streams are NEVER sent back as the main video URL!
        if (isVideo && url) {
            const meta = parseStreamMetadata(url);
            if (meta && meta.isAudio) {
                audioUrl = url;
                url = null;
            } else if (!isValidVideo(url)) {
                url = null;
            }
        }

        window.postMessage({
            type: 'magic_response_react_url_' + reqId,
            url: url,
            audioUrl: audioUrl
        }, '*');
    });

})();

(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0m';

		const totalMinutes = Math.round(diffMs / (1000 * 60));
		if (totalMinutes < 60) return `${totalMinutes}m`;

		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		// [ACCESSIBILITY] Make element keyboard focusable
		if (!element.hasAttribute('tabindex')) {
			element.setAttribute('tabindex', '0');
		}
		// [ACCESSIBILITY] Add role for screen readers
		if (!element.hasAttribute('role')) {
			element.setAttribute('role', 'button');
		}

		let pressTimer;
		let hideTimer;
		let isVisible = false;

		const show = () => {
			if (isVisible) return;
			isVisible = true;
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%) translateY(0)';
		};

		const hide = () => {
			if (!isVisible) return;
			isVisible = false;
			tooltip.style.opacity = '0';
			tooltip.style.transform = 'translateX(-50%) translateY(4px)';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});

		// [ACCESSIBILITY] Keyboard support
		element.addEventListener('focus', () => {
			show();
		});

		element.addEventListener('blur', () => {
			hide();
		});

		element.addEventListener('keydown', (e) => {
			// Show on Enter or Space
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				if (isVisible) {
					hide();
				} else {
					show();
				}
			}
			// Hide on Escape
			if (e.key === 'Escape') {
				hide();
			}
		});
	}

	function setTooltipContent(tooltip, text) {
		if (!tooltip) return;
		tooltip.replaceChildren();
		const lines = String(text)
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);

		lines.forEach((line, index) => {
			const row = document.createElement('div');
			row.className = index === 0 ? 'cc-tooltipTitle' : 'cc-tooltipLine';
			row.textContent = line;
			tooltip.appendChild(row);
		});
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'cc-tooltip';
		setTooltipContent(tip, text);
		document.body.appendChild(tip);
		return tip;
	}

	function formatCompactNumber(value) {
		if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
		if (value >= 1000) {
			const compact = Math.round(value / 100) / 10;
			return `${compact.toLocaleString()}k`;
		}
		return Math.round(value).toLocaleString();
	}

	class CounterUI {
		constructor({ onUsageRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.headerSeparator = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.contextIndicatorWrap = null;
			this.contextIndicator = null;
			this.contextIndicatorInner = null;
			this.contextPercent = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.contextTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;

			this.usageLine = null;
			this.usageSummary = null;
			this.usageSummarySeparator = null;
			this.sessionCompactSpan = null;
			this.weeklyCompactSpan = null;
			this.usageTooltip = null;
			this.usageTooltipTitle = null;
			this.contextGroup = null;
			this.contextUsedSpan = null;
			this.contextRemainingSpan = null;
			this.contextHealthSpan = null;
			this.sessionLabelSpan = null;
			this.sessionUsageSpan = null;
			this.sessionHintSpan = null;
			this.weeklyLabelSpan = null;
			this.weeklyUsageSpan = null;
			this.weeklyHintSpan = null;
			this.sessionGroup = null;
			this.weeklyGroup = null;
			this.sessionBar = null;
			this.sessionBarFill = null;
			this.weeklyBar = null;
			this.weeklyBarFill = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.sessionMarker = null;
			this.weeklyMarker = null;
			this.sessionWindowStartMs = null;
			this.weeklyWindowStartMs = null;
			this.sessionUsagePct = null;
			this.weeklyUsagePct = null;
			this.contextMetrics = null;
			this.refreshingUsage = false;

			this.domObserver = null;
			this.themeObserver = null;
		}

		/**
		 * [CLEANUP] Destroy the UI and release all resources.
		 * Properly disconnects observers and removes DOM elements.
		 */
		destroy() {
			// Disconnect observers
			if (this.domObserver) {
				this.domObserver.disconnect();
				this.domObserver = null;
			}
			if (this.themeObserver) {
				this.themeObserver.disconnect();
				this.themeObserver = null;
			}

			// Remove all tooltips
			document.querySelectorAll('.cc-tooltip').forEach(t => t.remove());

			// Remove header container
			if (this.headerContainer) {
				this.headerContainer.remove();
				this.headerContainer = null;
			}

			// Remove usage line
			if (this.usageLine) {
				this.usageLine.remove();
				this.usageLine = null;
			}

			// Clear references
			this.lengthTooltip = null;
			this.contextTooltip = null;
			this.usageTooltip = null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT,
				mutedColor: isDark ? CC.COLORS.HEADER_MUTED_DARK : CC.COLORS.HEADER_MUTED_LIGHT,
				headerSurface: isDark ? CC.COLORS.HEADER_SURFACE_DARK : CC.COLORS.HEADER_SURFACE_LIGHT,
				headerBorder: isDark ? CC.COLORS.HEADER_BORDER_DARK : CC.COLORS.HEADER_BORDER_LIGHT,
				tooltipBg: isDark ? CC.COLORS.TOOLTIP_BG_DARK : CC.COLORS.TOOLTIP_BG_LIGHT,
				tooltipBorder: isDark ? CC.COLORS.TOOLTIP_BORDER_DARK : CC.COLORS.TOOLTIP_BORDER_LIGHT,
				tooltipText: isDark ? CC.COLORS.TOOLTIP_TEXT_DARK : CC.COLORS.TOOLTIP_TEXT_LIGHT,
				tooltipMuted: isDark ? CC.COLORS.TOOLTIP_MUTED_DARK : CC.COLORS.TOOLTIP_MUTED_LIGHT,
				tooltipShadow: isDark ? CC.COLORS.TOOLTIP_SHADOW_DARK : CC.COLORS.TOOLTIP_SHADOW_LIGHT
			};
		}

		refreshProgressChrome() {
			const {
				strokeColor,
				fillColor,
				markerColor,
				boldColor,
				mutedColor,
				headerSurface,
				headerBorder,
				tooltipBg,
				tooltipBorder,
				tooltipText,
				tooltipMuted,
				tooltipShadow
			} = this.getProgressChrome();

			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.lengthBar, { fillWarn: fillColor });
			applyBarChrome(this.sessionBar, { fillWarn: CC.COLORS.RED_WARNING });
			applyBarChrome(this.weeklyBar, { fillWarn: CC.COLORS.RED_WARNING });
			if (this.headerContainer) {
				this.headerContainer.style.setProperty('--cc-header-text', boldColor);
				this.headerContainer.style.setProperty('--cc-header-muted', mutedColor);
				this.headerContainer.style.setProperty('--cc-header-surface', headerSurface);
				this.headerContainer.style.setProperty('--cc-header-border', headerBorder);
			}
			if (this.usageLine) {
				this.usageLine.style.setProperty('--cc-divider', strokeColor);
				this.usageLine.style.setProperty('--cc-text-strong', mutedColor);
				this.usageLine.style.setProperty('--cc-text-muted', mutedColor);
			}
			document.querySelectorAll('.cc-tooltip').forEach((tooltip) => {
				tooltip.style.setProperty('--cc-tooltip-bg', tooltipBg);
				tooltip.style.setProperty('--cc-tooltip-border', tooltipBorder);
				tooltip.style.setProperty('--cc-tooltip-text', tooltipText);
				tooltip.style.setProperty('--cc-tooltip-muted', tooltipMuted);
				tooltip.style.setProperty('--cc-tooltip-shadow', tooltipShadow);
			});
		}

		_formatUsageLabel(label, pct, resetMs) {
			const pctText = typeof pct === 'number' ? `${pct}% used` : '-';
			const resetText = resetMs ? `, resets in ${formatResetCountdown(resetMs)}` : '';
			return `${label} ${pctText}${resetText}`;
		}

		_renderUsageSummary() {
			const hasSession = typeof this.sessionUsagePct === 'number';
			const hasWeekly = typeof this.weeklyUsagePct === 'number';
			this.sessionCompactSpan?.classList.toggle('cc-hidden', !hasSession);
			this.weeklyCompactSpan?.classList.toggle('cc-hidden', !hasWeekly);
			this.usageSummarySeparator?.classList.toggle('cc-hidden', !(hasSession && hasWeekly));

			if (this.sessionCompactSpan) {
				this.sessionCompactSpan.textContent = hasSession
					? this._formatUsageLabel('Session', this.sessionUsagePct, this.sessionResetMs)
					: 'Session -';
			}
			if (this.weeklyCompactSpan) {
				this.weeklyCompactSpan.textContent = hasWeekly
					? this._formatUsageLabel('Weekly', this.weeklyUsagePct, this.weeklyResetMs)
					: 'Weekly -';
			}
		}

		_renderUsageTooltipDetails() {
			if (this.sessionUsageSpan) {
				this.sessionUsageSpan.textContent =
					typeof this.sessionUsagePct === 'number'
						? this._formatUsageLabel('', this.sessionUsagePct, this.sessionResetMs).trim()
						: '';
			}
			if (this.weeklyUsageSpan) {
				this.weeklyUsageSpan.textContent =
					typeof this.weeklyUsagePct === 'number'
						? this._formatUsageLabel('', this.weeklyUsagePct, this.weeklyResetMs).trim()
						: '';
			}
		}

		_renderContextDetails() {
			const metrics = this.contextMetrics;
			const hasContext = !!metrics && typeof metrics.totalTokens === 'number';
			this.contextGroup?.classList.toggle('cc-hidden', !hasContext);
			if (!hasContext) return;

			if (this.contextUsedSpan) {
				this.contextUsedSpan.textContent = `~${formatCompactNumber(metrics.totalTokens)} tokens used`;
			}
			if (this.contextRemainingSpan) {
				this.contextRemainingSpan.textContent = `~${formatCompactNumber(metrics.remainingTokens)} tokens remaining`;
			}
			if (this.contextHealthSpan) {
				const health = metrics.contextHealth || 'Healthy';
				this.contextHealthSpan.textContent = `Context health: ${health}`;
				this.contextHealthSpan.classList.toggle('cc-usageHealth--moderate', health === 'Moderate');
				this.contextHealthSpan.classList.toggle('cc-usageHealth--near', health === 'Nearing context');
				this.contextHealthSpan.classList.toggle('cc-usageHealth--critical', health === 'Extremely high');
			}
		}

		_getContextHealthColor(health) {
			switch (health) {
				case 'Moderate':
					return CC.COLORS.CONTEXT_HEALTH_YELLOW;
				case 'Nearing context':
					return CC.COLORS.CONTEXT_HEALTH_ORANGE;
				case 'Extremely high':
					return CC.COLORS.CONTEXT_HEALTH_RED;
				default:
					return CC.COLORS.CONTEXT_HEALTH_GREEN;
			}
		}

		_renderContextIndicator() {
			const metrics = this.contextMetrics;
			const hasContext = !!metrics && typeof metrics.usedPct === 'number';
			this.contextIndicatorWrap?.classList.toggle('cc-hidden', !hasContext);
			if (!hasContext || !this.contextIndicator) {
				if (this.contextPercent) this.contextPercent.textContent = '';
				return;
			}

			const pct = Math.max(0, Math.min(100, metrics.usedPct));
			const color = this._getContextHealthColor(metrics.contextHealth);
			this.contextIndicator.style.setProperty('--cc-context-color', color);
			this.contextIndicator.style.setProperty('--cc-context-pct', `${pct}%`);
			if (this.contextPercent) this.contextPercent.textContent = `${Math.round(pct)}%`;
		}

		_renderContextTooltip() {
			if (!this.contextTooltip) return;
			const metrics = this.contextMetrics;
			if (!metrics || typeof metrics.totalTokens !== 'number') {
				setTooltipContent(this.contextTooltip, 'Context health.\nUnavailable for this chat yet.');
				return;
			}

			const health = metrics.contextHealth || 'Healthy';
			const colorMeaning =
				health === 'Extremely high'
					? 'Red means the chat is close to compaction. Open a new chat soon.'
					: health === 'Nearing context'
						? 'Orange means you are getting close to the context limit.'
						: health === 'Moderate'
							? 'Yellow means the chat is growing and worth keeping an eye on.'
							: 'Green means the current chat still has comfortable context headroom.';

			setTooltipContent(
				this.contextTooltip,
				`Context health: ${health}\n~${formatCompactNumber(metrics.totalTokens)} tokens used\n~${formatCompactNumber(metrics.remainingTokens)} tokens remaining\n${colorMeaning}`
			);
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'cc-header';

			// [ACCESSIBILITY] Add ARIA labels and roles
			this.headerContainer.setAttribute('role', 'region');
			this.headerContainer.setAttribute('aria-label', 'Claude Counter: Token and usage metrics');
			this.headerContainer.setAttribute('aria-live', 'polite');

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem cc-headerMeta';
			this.headerDisplay.setAttribute('role', 'group');

			this.headerSeparator = document.createElement('span');
			this.headerSeparator.className = 'cc-headerSeparator';

			this.lengthGroup = document.createElement('span');
			this.lengthGroup.className = 'cc-lengthGroup';
			// [ACCESSIBILITY] Add meter semantics for token count
			this.lengthGroup.setAttribute('role', 'meter');
			this.lengthGroup.setAttribute('aria-label', 'Token count');
			this.lengthGroup.setAttribute('aria-valuemin', '0');
			this.lengthGroup.setAttribute('aria-valuemax', '200000');
			this.lengthGroup.setAttribute('aria-valuenow', '0');

			this.lengthDisplay = document.createElement('span');
			this.lengthDisplay.className = 'cc-lengthText';
			this.lengthDisplay.setAttribute('aria-hidden', 'true');
			this.contextIndicatorWrap = document.createElement('span');
			this.contextIndicatorWrap.className = 'cc-contextIndicatorWrap cc-hidden';
			this.contextIndicator = document.createElement('span');
			this.contextIndicator.className = 'cc-contextIndicator';
			this.contextIndicatorInner = document.createElement('span');
			this.contextIndicatorInner.className = 'cc-contextIndicatorInner';
			this.contextIndicator.appendChild(this.contextIndicatorInner);
			this.contextPercent = document.createElement('span');
			this.contextPercent.className = 'cc-contextPercent';
			this.contextIndicatorWrap.appendChild(this.contextIndicator);
			this.contextIndicatorWrap.appendChild(this.contextPercent);
			this.cachedDisplay = document.createElement('span');
			this.cachedDisplay.className = 'cc-cacheBadge';
			this.cacheTimeSpan = null; // reference to inner time span
			this.contextTooltip = makeTooltip('Context health.\nUnavailable for this chat yet.');

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();

			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			// [CLEANUP] Store observer reference for cleanup
			this.themeObserver = new MutationObserver(() => this.refreshProgressChrome());
			this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className = 'cc-usageRow cc-hidden';

			this.usageSummary = document.createElement('div');
			this.usageSummary.className = 'cc-usageSummary';

			this.sessionCompactSpan = document.createElement('span');
			this.sessionCompactSpan.className = 'cc-usageCompact';
			this.sessionCompactSpan.textContent = 'Session -';

			this.usageSummarySeparator = document.createElement('span');
			this.usageSummarySeparator.className = 'cc-usageSummarySeparator cc-hidden';
			this.usageSummarySeparator.textContent = '·';

			this.weeklyCompactSpan = document.createElement('span');
			this.weeklyCompactSpan.className = 'cc-usageCompact';
			this.weeklyCompactSpan.textContent = 'Weekly -';

			this.usageSummary.appendChild(this.sessionCompactSpan);
			this.usageSummary.appendChild(this.usageSummarySeparator);
			this.usageSummary.appendChild(this.weeklyCompactSpan);

			this.usageTooltip = document.createElement('div');
			this.usageTooltip.className = 'cc-tooltip cc-tooltip--usage';

			this.usageTooltipTitle = document.createElement('div');
			this.usageTooltipTitle.className = 'cc-tooltipTitle';
			this.usageTooltipTitle.textContent = 'Usage and context';

			this.sessionLabelSpan = document.createElement('span');
			this.sessionLabelSpan.className = 'cc-usageDetailLabel';
			this.sessionLabelSpan.textContent = 'Session';

			this.sessionUsageSpan = document.createElement('span');
			this.sessionUsageSpan.className = 'cc-usageDetailText';

			this.sessionBar = document.createElement('div');
			this.sessionBar.className = 'cc-bar cc-bar--usage';
			this.sessionBarFill = document.createElement('div');
			this.sessionBarFill.className = 'cc-bar__fill';
			this.sessionMarker = document.createElement('div');
			this.sessionMarker.className = 'cc-bar__marker cc-hidden';
			this.sessionMarker.style.left = '0%';
			this.sessionBar.appendChild(this.sessionBarFill);
			this.sessionBar.appendChild(this.sessionMarker);

			this.sessionHintSpan = document.createElement('span');
			this.sessionHintSpan.className = 'cc-usageHint';
			this.sessionHintSpan.textContent = '5-hour window. Marker shows where you are in the window.';

			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-usageDetailText';

			this.weeklyBar = document.createElement('div');
			this.weeklyBar.className = 'cc-bar cc-bar--usage';
			this.weeklyBarFill = document.createElement('div');
			this.weeklyBarFill.className = 'cc-bar__fill';
			this.weeklyMarker = document.createElement('div');
			this.weeklyMarker.className = 'cc-bar__marker cc-hidden';
			this.weeklyMarker.style.left = '0%';
			this.weeklyBar.appendChild(this.weeklyBarFill);
			this.weeklyBar.appendChild(this.weeklyMarker);

			this.weeklyHintSpan = document.createElement('span');
			this.weeklyHintSpan.className = 'cc-usageHint';
			this.weeklyHintSpan.textContent = '7-day window. Marker shows where you are in the window.';

			this.contextGroup = document.createElement('div');
			this.contextGroup.className = 'cc-usageDetail cc-hidden';

			const contextLabelSpan = document.createElement('span');
			contextLabelSpan.className = 'cc-usageDetailLabel';
			contextLabelSpan.textContent = 'Context';

			this.contextUsedSpan = document.createElement('span');
			this.contextUsedSpan.className = 'cc-usageDetailText';

			this.contextRemainingSpan = document.createElement('span');
			this.contextRemainingSpan.className = 'cc-usageDetailText';

			this.contextHealthSpan = document.createElement('span');
			this.contextHealthSpan.className = 'cc-usageHint cc-usageHealth';

			this.contextGroup.appendChild(contextLabelSpan);
			this.contextGroup.appendChild(this.contextUsedSpan);
			this.contextGroup.appendChild(this.contextRemainingSpan);
			this.contextGroup.appendChild(this.contextHealthSpan);

			this.sessionGroup = document.createElement('div');
			this.sessionGroup.className = 'cc-usageDetail';
			this.sessionGroup.appendChild(this.sessionLabelSpan);
			this.sessionGroup.appendChild(this.sessionUsageSpan);
			this.sessionGroup.appendChild(this.sessionBar);
			this.sessionGroup.appendChild(this.sessionHintSpan);

			this.weeklyLabelSpan = document.createElement('span');
			this.weeklyLabelSpan.className = 'cc-usageDetailLabel';
			this.weeklyLabelSpan.textContent = 'Weekly';

			this.weeklyGroup = document.createElement('div');
			this.weeklyGroup.className = 'cc-usageDetail';
			this.weeklyGroup.appendChild(this.weeklyLabelSpan);
			this.weeklyGroup.appendChild(this.weeklyUsageSpan);
			this.weeklyGroup.appendChild(this.weeklyBar);
			this.weeklyGroup.appendChild(this.weeklyHintSpan);

			this.usageTooltip.appendChild(this.usageTooltipTitle);
			this.usageTooltip.appendChild(this.sessionGroup);
			this.usageTooltip.appendChild(this.weeklyGroup);
			this.usageTooltip.appendChild(this.contextGroup);
			document.body.appendChild(this.usageTooltip);

			// [CONFIG] Inline burn-rate readout. Hidden until forecast data arrives.
			this.burnRateSpan = document.createElement('span');
			this.burnRateSpan.className = 'cc-usageCompact cc-burnRate cc-hidden';
			this.burnRateSpan.textContent = '';
			this.burnRateSeparator = document.createElement('span');
			this.burnRateSeparator.className = 'cc-usageSummarySeparator cc-hidden';
			this.burnRateSeparator.textContent = '·';
			this.usageSummary.appendChild(this.burnRateSeparator);
			this.usageSummary.appendChild(this.burnRateSpan);

			this.usageLine.appendChild(this.usageSummary);

			this.refreshProgressChrome();

			this.usageSummary.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageSummary.classList.add('cc-usageSummary--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageSummary.classList.remove('cc-usageSummary--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Approximate token count.\nExcludes the system prompt and may differ from Claude's count.\nAfter context compaction, this number is no longer reliable.\nBar scale: 200k context window."
			);
			setupTooltip(
				this.lengthGroup,
				this.lengthTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.cachedDisplay,
				makeTooltip('Continuing in cached context is significantly cheaper.'),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.contextIndicatorWrap,
				this.contextTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.usageSummary,
				this.usageTooltip,
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const chatMenu = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (!chatMenu) return;
			const anchor = chatMenu.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || chatMenu.parentElement;
			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!modelSelector) return;
			const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
			const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
			const findToolbarRow = (el, stopAt) => {
				let cur = el;
				while (cur && cur !== document.body) {
					if (stopAt && cur === stopAt) break;
					if (cur !== el && cur.nodeType === 1) {
						const style = window.getComputedStyle(cur);
						if (style.display === 'flex' && style.flexDirection === 'row') {
							const buttons = cur.querySelectorAll('button').length;
							if (buttons > 1) return cur;
						}
					}
					cur = cur.parentElement;
				}
				return null;
			};

			const toolbarRow =
				(gridContainer ? findToolbarRow(modelSelector, gridArea || gridContainer) : null) ||
				findToolbarRow(modelSelector) ||
				modelSelector.parentElement?.parentElement?.parentElement;
			if (!toolbarRow) return;
			if (toolbarRow.nextElementSibling !== this.usageLine) {
				toolbarRow.after(this.usageLine);
			}
			this.refreshProgressChrome();
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			if (this.cacheTimeSpan) {
				this.cachedDisplay?.classList.toggle('cc-cacheBadge--pending', pending);
			}
		}

		setConversationMetrics({ totalTokens, remainingTokens, usedPct, contextHealth, cachedUntil } = {}) {
			this.pendingCache = false;
			this.contextMetrics = null;

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderContextDetails();
				this._renderContextIndicator();
				this._renderContextTooltip();
				this._renderHeader();
				return;
			}

			this.contextMetrics = {
				totalTokens,
				remainingTokens:
					typeof remainingTokens === 'number'
						? remainingTokens
						: Math.max(0, CC.CONST.CONTEXT_LIMIT_TOKENS - totalTokens),
				usedPct:
					typeof usedPct === 'number'
						? usedPct
						: Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100)),
				contextHealth: contextHealth || 'Healthy'
			};

			// [ACCESSIBILITY] Update meter value
			this.lengthGroup.setAttribute('aria-valuenow', String(totalTokens));

			const pct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;

			// Mini bar (hide when full - context is definitely compacted by then)
			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
				if (this.lengthTooltip) {
					setTooltipContent(
						this.lengthTooltip,
						"Approximate token count.\nUses a generic tokenizer and may differ from Claude's count.\nAfter context compaction, this number is no longer reliable."
					);
				}
			} else {
				this.lengthDisplay.style.opacity = '';
				if (this.lengthTooltip) {
					setTooltipContent(
						this.lengthTooltip,
						"Approximate token count.\nExcludes the system prompt and may differ from Claude's count.\nAfter context compaction, this number is no longer reliable.\nBar scale: 200k context window."
					);
				}
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();

				const barContainer = document.createElement('span');
				barContainer.className = 'cc-lengthBarWrap';
				barContainer.appendChild(bar);

				this.lengthGroup.replaceChildren(this.lengthDisplay, barContainer);
			}

			// Cache timer
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cachedDisplay.classList.toggle('cc-cacheBadge--pending', this.pendingCache);
				this.cachedDisplay.replaceChildren(document.createTextNode('cached '), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.classList.remove('cc-cacheBadge--pending');
				this.cachedDisplay.textContent = '';
			}

			this._renderContextDetails();
			this._renderContextIndicator();
			this._renderContextTooltip();
			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();

			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;

			if (!hasTokens) return;

			if (hasCache) {
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					this.headerSeparator,
					this.cachedDisplay,
					this.contextIndicatorWrap
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup, this.contextIndicatorWrap);
			}

			this.headerContainer.appendChild(this.headerDisplay);
		}

		setUsage(usage) {
			this.refreshProgressChrome();
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const hasSession = !!(session && typeof session.utilization === 'number');
			const hasWeekly = !!(weekly && typeof weekly.utilization === 'number');
			const hasAnyUsage = hasSession || hasWeekly;
			this.usageLine?.classList.toggle('cc-hidden', !hasAnyUsage);
			this.sessionGroup?.classList.toggle('cc-hidden', !hasSession);

			if (hasSession) {
				const rawPct = session.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.sessionUsagePct = pct;
				this.sessionResetMs = session.resets_at ? Date.parse(session.resets_at) : null;
				this.sessionWindowStartMs = this.sessionResetMs ? this.sessionResetMs - 5 * 60 * 60 * 1000 : null;

				const width = Math.max(0, Math.min(100, rawPct));
				this.sessionBarFill.style.width = `${width}%`;
				this.sessionBarFill.classList.toggle('cc-warn', width >= 90);
				this.sessionBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.sessionUsagePct = null;
				this.sessionBarFill.style.width = '0%';
				this.sessionBarFill.classList.remove('cc-warn', 'cc-full');
				this.sessionResetMs = null;
				this.sessionWindowStartMs = null;
			}

			this.weeklyGroup?.classList.toggle('cc-hidden', !hasWeekly);

			if (hasWeekly) {
				const rawPct = weekly.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.weeklyUsagePct = pct;
				this.weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
				this.weeklyWindowStartMs = this.weeklyResetMs ? this.weeklyResetMs - 7 * 24 * 60 * 60 * 1000 : null;

				const width = Math.max(0, Math.min(100, rawPct));
				this.weeklyBarFill.style.width = `${width}%`;
				this.weeklyBarFill.classList.toggle('cc-warn', width >= 90);
				this.weeklyBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.weeklyUsagePct = null;
				this.weeklyResetMs = null;
				this.weeklyWindowStartMs = null;
				this.weeklyBarFill.style.width = '0%';
				this.weeklyBarFill.classList.remove('cc-warn', 'cc-full');
			}

			this._renderUsageSummary();
			this._renderUsageTooltipDetails();
			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();

			if (this.sessionMarker && this.sessionWindowStartMs && this.sessionResetMs) {
				const total = this.sessionResetMs - this.sessionWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.sessionWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.sessionMarker.classList.remove('cc-hidden');
				this.sessionMarker.style.left = `${pct}%`;
			} else if (this.sessionMarker) {
				this.sessionMarker.classList.add('cc-hidden');
			}

			if (this.weeklyMarker && this.weeklyWindowStartMs && this.weeklyResetMs) {
				const total = this.weeklyResetMs - this.weeklyWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.weeklyWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.weeklyMarker.classList.remove('cc-hidden');
				this.weeklyMarker.style.left = `${pct}%`;
			} else if (this.weeklyMarker) {
				this.weeklyMarker.classList.add('cc-hidden');
			}
		}

		/**
		 * [CONFIG] Update the inline burn-rate readout. Pass null to hide.
		 * @param {{ perTurn: number|null, perHour: number|null, samples: number }|null} rate
		 */
		setBurnRate(rate) {
			if (!this.burnRateSpan) return;
			const hasRate = !!rate && 'number' === typeof rate.perTurn && rate.perTurn > 0;
			this.burnRateSpan.classList.toggle('cc-hidden', !hasRate);
			this.burnRateSeparator?.classList.toggle('cc-hidden', !hasRate);
			if (!hasRate) {
				this.burnRateSpan.textContent = '';
				return;
			}
			const perTurn = formatCompactNumber(rate.perTurn);
			const perHour = formatCompactNumber(rate.perHour || 0);
			this.burnRateSpan.textContent = `~${perTurn} tok/turn · ~${perHour}/h`;
		}

		tick() {
			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Reset countdown text + time markers
			this._renderUsageSummary();
			this._renderUsageTooltipDetails();

			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();

(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script',
		// [CONFIG] Phase 2 — active model label lives inside the model selector trigger.
		ACTIVE_MODEL_LABEL: '[data-testid="model-selector-dropdown"]'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		CONTEXT_LIMIT_TOKENS: 200000
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		HEADER_MUTED_DARK: '#bdb5a8',
		HEADER_MUTED_LIGHT: '#6c655b',
		HEADER_SURFACE_DARK: 'rgba(255, 248, 236, 0.06)',
		HEADER_SURFACE_LIGHT: 'rgba(36, 31, 24, 0.05)',
		HEADER_BORDER_DARK: 'rgba(255, 248, 236, 0.12)',
		HEADER_BORDER_LIGHT: 'rgba(36, 31, 24, 0.10)',
		TOOLTIP_BG_DARK: 'rgba(48, 42, 36, 0.98)',
		TOOLTIP_BG_LIGHT: 'rgba(247, 242, 234, 0.98)',
		TOOLTIP_BORDER_DARK: 'rgba(255, 248, 236, 0.08)',
		TOOLTIP_BORDER_LIGHT: 'rgba(36, 31, 24, 0.08)',
		TOOLTIP_TEXT_DARK: '#f5f1e8',
		TOOLTIP_TEXT_LIGHT: '#23201c',
		TOOLTIP_MUTED_DARK: '#ccc4b7',
		TOOLTIP_MUTED_LIGHT: '#5f574d',
		TOOLTIP_SHADOW_DARK: '0 14px 28px rgba(0, 0, 0, 0.22)',
		TOOLTIP_SHADOW_LIGHT: '0 14px 26px rgba(36, 26, 14, 0.10)',
		CONTEXT_HEALTH_GREEN: '#4a9b5f',
		CONTEXT_HEALTH_YELLOW: '#c7a233',
		CONTEXT_HEALTH_ORANGE: '#d57d2a',
		CONTEXT_HEALTH_RED: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});
})();

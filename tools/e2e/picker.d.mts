import type { Locator } from 'playwright-core';

export function clickPickerOption(option: Pick<Locator, 'page' | 'click'>, timeout?: number): Promise<void>;

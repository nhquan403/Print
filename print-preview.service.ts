import { useAuth } from '@contexts';
import { DateConfig } from '@lib/constants';
import { useCanvasToImage } from '@lib/hooks';
import { FontWeight, convertToCamelObject, logError } from '@lib/utils';
import { useGlobalStore } from '@store';
import { format } from 'date-fns';
import jsPDF from 'jspdf';
import { isEmpty } from 'lodash';
import { pdfjs } from 'react-pdf';
import { PrintPDFElementId, PrintPDFLPageSizemm, PrintPDFLayoutType } from './print-preview.const';
import {
    TPrintPDFConfig,
    TPrintPDFImage,
    TPrintPDFLayoutItem,
    TPrintPDFLayoutItemType,
    TPrintPDFPageSettings,
    TPrintPDFStyle,
    TPrintPDFTableColumn,
    TPrintPDFTableRow,
    TPrintPreviewForm
} from './print-preview.model';

const CANVAS_RENDER_TIMEOUT_MS = 15000;
const PAGE_OVERFLOW_EPSILON_PX = 1;
const IMAGE_LOAD_TIMEOUT_MS = 10000;

// Content layout: each page of the attached PDF is rasterized and printed as `image_1` on its own page.
const PDF_PAGE_RENDER_SCALE = 1.2;
const PDF_PAGE_JPEG_QUALITY = 0.85;

// Comment box (`comment_text`) pagination.
const COMMENT_TEXT_SELECTOR = '[data-comment-text="true"]';
// With less room than this left for the first comment chunk, the whole comment starts on the next page instead.
const COMMENT_MIN_FIRST_CHUNK_HEIGHT_PX = 20;
// Headroom kept below the comment text so its last line isn't clipped after canvas rendering.
const COMMENT_RENDER_SAFETY_PX = 20;
// Gap left between the stretched last comment box and the footer.
const COMMENT_BOTTOM_GAP_PX = 10;
const COMMENT_CONTINUATION_MARGIN_TOP = '5mm';
const COMMENT_MAX_CHUNKS = 200;

// Only these two weights are used in print layouts; embedding all 9 Noto Sans JP TTFs
// (~45 MB as base64) exceeds WKWebView's hard limit for data: URIs in img.src.
const PRINT_FONT_WEIGHTS: FontWeight[] = ['400', '700'];

const buildSlimFontCss = (fontData: Record<FontWeight, string> | undefined): string => {
    if (!fontData) {
        return '';
    }

    return PRINT_FONT_WEIGHTS.filter((w) => fontData[w])
        .map(
            (w) =>
                `@font-face { font-family: 'Noto Sans JP'; font-style: normal; font-weight: ${w}; src: url(${fontData[w]}) format('truetype'); }`
        )
        .join('\n');
};

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
    Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        })
    ]);

const detectSafari = (): boolean => /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const detectIPad = (): boolean => /iPad|Macintosh/i.test(navigator.userAgent) && 'ontouchend' in document;

/**
 * Print preview render engine.
 *
 * Scope note: only `PrintPDFLayoutType.OralAgeReport` (single page, config-driven
 * container/text/table items) and the image items (`image_1`, `image_N`, plus the
 * Content layout's PDF-page-as-`image_1`) are implemented. The other reference layout
 * types are intentionally out of scope for this phase.
 */
export const usePrintPreviewService = <T = any,>(layoutType: PrintPDFLayoutType, data?: T, images?: TPrintPDFImage[]) => {
    const auth = useAuth();
    const canvasToImage = useCanvasToImage();

    const fontData = useGlobalStore((state) => state.fontData);

    const isContentLayout = layoutType === PrintPDFLayoutType.Content;

    const loadLocalConfig = async (): Promise<TPrintPDFConfig | undefined> => {
        // Only a portrait config exists for this layout.
        const configId = `${layoutType}-portrait`;

        try {
            const module = await import(`./configurations/${configId}.json`);
            const template = module.default ?? module;

            return convertToCamelObject<TPrintPDFConfig>(template);
        } catch (error) {
            logError('[PrintPreview] Failed to load config', error);

            return undefined;
        }
    };

    const getPageSizeMm = (
        pageSettings: Pick<TPrintPDFPageSettings, 'size' | 'widthMm' | 'heightMm' | 'orientation'> = {}
    ) => {
        const { size = 'A4', widthMm, heightMm, orientation = 'portrait' } = pageSettings;
        const pageSize = widthMm && heightMm ? { width: widthMm, height: heightMm } : PrintPDFLPageSizemm[size];

        if (!pageSize) {
            logError('[PrintPreview] Unknown page size, falling back to A4', size);
        }

        const resolvedPageSize = pageSize ?? PrintPDFLPageSizemm.A4;
        const isPortrait = orientation === 'portrait';

        return {
            pageWidth: isPortrait ? resolvedPageSize.width : resolvedPageSize.height,
            pageHeight: isPortrait ? resolvedPageSize.height : resolvedPageSize.width
        };
    };

    // For the Content layout with an attached PDF, `pdfImageUrl` (one rasterized PDF page) becomes `image_1`;
    // otherwise every passed image is exposed as `image_N` / `image_N_date`.
    const buildTemplateVariables = (formValues: TPrintPreviewForm, pdfImageUrl?: string): Record<string, any> => {
        const clinicName = auth.currentProfile?.clinicName;
        const templateVariables: Record<string, any> = {
            clinic_name: clinicName ? `${clinicName}クリニック` : 'さくら歯科クリニック',
            print_datetime: format(new Date(), DateConfig.Format.DefaultDate),
            report_title: formValues.title?.trim() || '',
            comment_text: formValues?.comment || '',
            result_type: formValues?.resultType ?? 'allResults'
        };

        if (isContentLayout && pdfImageUrl) {
            templateVariables.image_1 = pdfImageUrl;
        } else {
            (images ?? []).forEach((image, index) => {
                templateVariables[`image_${index + 1}`] = image?.fileUrl ?? '';
                templateVariables[`image_${index + 1}_date`] = image?.date
                    ? format(image.date, DateConfig.Format.DefaultDate)
                    : '';
            });
        }

        if (data && typeof data === 'object' && !Array.isArray(data)) {
            Object.assign(templateVariables, data);
        }

        return templateVariables;
    };

    const applyElementCommonStyle = (
        config: TPrintPDFConfig,
        el: HTMLElement,
        style: TPrintPDFStyle = {},
        type: TPrintPDFLayoutItemType
    ) => {
        const pageSettings = config.pageSettings;

        if (type === 'text') {
            el.style.fontFamily = pageSettings?.font?.family ?? 'Noto Sans JP, sans-serif';
            el.style.fontSize = pageSettings?.font?.size ?? '12px';
            el.style.lineHeight = pageSettings?.font?.line_height ?? '18px';
            el.style.color = pageSettings?.font?.color ?? '#101828';
        }

        if (!style) {
            return;
        }

        const { align, layout, ...rest } = style;

        Object.entries(rest).forEach(([key, value]) => {
            if (isEmpty(value)) {
                return;
            }

            try {
                el.style[key] = value;
            } catch (error) {
                logError('[PrintPreview] Failed to apply style', key, value, error);
            }
        });

        if (align && type === 'text') {
            el.style.textAlign = align;
        }

        if (align && type === 'image') {
            el.style.verticalAlign = align;
        }

        if (layout) {
            el.style.display = 'flex';
            el.style.flexDirection = layout === 'horizontal' ? 'row' : 'column';
        }
    };

    const replaceTemplateVars = (value: string | undefined, templateVariables: Record<string, any>): string => {
        if (!value) {
            return '';
        }

        return value.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
            const resolved = templateVariables[key];

            return resolved !== null && resolved !== undefined ? String(resolved) : '';
        });
    };

    // Items listed in the matching variant's `hidden_ids` are skipped (e.g. per radio choice).
    const isHiddenByVariant = (config: TPrintPDFConfig, item: TPrintPDFLayoutItem, variables: Record<string, any>) => {
        if (!item.id || !config.variantBy) {
            return false;
        }
        const variant = config.variants?.find((v) => v.when === variables[config.variantBy]);

        return Boolean(variant?.hiddenIds?.includes(item.id));
    };

    const renderTableHeader = (table: HTMLTableElement, columns: TPrintPDFTableColumn[] = []) => {
        if (isEmpty(columns)) {
            return;
        }

        const thead = document.createElement('thead');
        const tr = document.createElement('tr');

        columns.forEach((col) => {
            const th = document.createElement('th');
            th.textContent = col.label || '';

            if (col.width) {
                th.style.width = col.width;
            }

            if (col.style) {
                Object.assign(th.style, col.style);
            }

            tr.appendChild(th);
        });

        thead.appendChild(tr);
        table.appendChild(thead);
    };

    const CIRCLED_DIGIT_REGEX = /([①-⑧])/; // ① - ⑧
    // Wraps circled digits in a colored <span>; uses textContent/text nodes only (no innerHTML).
    const appendTextWithCircledColor = (el: HTMLElement, text: string, circledColor?: string) => {
        if (!circledColor) {
            el.textContent = text;

            return;
        }

        text.split(CIRCLED_DIGIT_REGEX).forEach((part) => {
            if (!part) {
                return;
            }
            if (CIRCLED_DIGIT_REGEX.test(part)) {
                const span = document.createElement('span');
                span.style.color = circledColor;
                span.textContent = part;
                el.appendChild(span);
            } else {
                el.appendChild(document.createTextNode(part));
            }
        });
    };

    // Renders a table cell as stacked lines, each with its own style (e.g. a bold label
    // line above a plain detail line) — one `<div>` per non-empty resolved item, so a row
    // with no detail line doesn't leave a blank line's worth of extra height.
    const renderContainerCell = (
        td: HTMLTableCellElement,
        items: TPrintPDFLayoutItem[],
        rowData: Record<string, any>
    ) => {
        items.forEach((item) => {
            if (item.type !== 'text') {
                return;
            }

            const text = replaceTemplateVars(item.value, rowData);

            if (!text) {
                return;
            }

            const lineEl = document.createElement('div');

            if (item.style) {
                Object.assign(lineEl.style, item.style);
            }

            appendTextWithCircledColor(lineEl, text, item.circleColor);
            td.appendChild(lineEl);
        });
    };

    const renderTableRow = (row: TPrintPDFTableRow, rowData: Record<string, any>, tbody: HTMLTableSectionElement) => {
        const tr = document.createElement('tr');

        (row.cells || []).forEach((cell) => {
            const td = document.createElement('td');

            if (cell.style) {
                Object.assign(td.style, cell.style);
            }

            const cellItems = cell.items;

            if (cell.type === 'container' && cellItems && !isEmpty(cellItems)) {
                renderContainerCell(td, cellItems, rowData);
            } else {
                td.textContent = replaceTemplateVars(cell.value, rowData);
            }

            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    };

    const renderTableBody = (
        table: HTMLTableElement,
        tableItem: TPrintPDFLayoutItem,
        templateVariables: Record<string, any>
    ) => {
        if (isEmpty(tableItem.rows)) {
            return;
        }

        const tbody = document.createElement('tbody');
        const dataArray = tableItem.dataKey ? templateVariables[tableItem.dataKey] : undefined;
        const shouldRenderDynamic = Array.isArray(dataArray) && tableItem.rows.length === 1;

        if (shouldRenderDynamic) {
            const templateRow = tableItem.rows[0];
            dataArray.forEach((rowData) => renderTableRow(templateRow, rowData, tbody));
        } else {
            tableItem.rows.forEach((row) => renderTableRow(row, templateVariables, tbody));
        }

        table.appendChild(tbody);
    };

    const renderTable = (
        config: TPrintPDFConfig,
        item: TPrintPDFLayoutItem,
        parent: HTMLElement,
        templateVariables: Record<string, any>
    ) => {
        const table = document.createElement('table');

        if (item.id) {
            table.dataset.layoutId = item.id;
        }

        if (item.dataKey) {
            table.dataset.dynamicRows = 'true';
        }

        if (item.maxRowsPerPage) {
            table.dataset.maxRowsPerPage = String(item.maxRowsPerPage);
        }

        if (item.style) {
            Object.assign(table.style, item.style);
        }

        renderTableHeader(table, item.header);
        renderTableBody(table, item, templateVariables);

        parent.appendChild(table);
    };

    const renderLayoutItemsToHtml = (
        config: TPrintPDFConfig,
        items: TPrintPDFLayoutItem[] = [],
        parent: HTMLElement,
        templateVariables: Record<string, any>
    ) => {
        items.forEach((item) => {
            if (!item.type) {
                return;
            }

            if (isHiddenByVariant(config, item, templateVariables)) {
                return;
            }

            if (item.type === 'container') {
                const container = document.createElement('div');
                container.style.boxSizing = 'border-box';

                if (item.id) {
                    container.dataset.layoutId = item.id;
                }

                applyElementCommonStyle(config, container, item.style, item.type);

                if (!isEmpty(item.items)) {
                    renderLayoutItemsToHtml(config, item.items, container, templateVariables);
                }

                if (config.pageSettings.orientation === 'landscape' && item.id === 'image_section') {
                    container.style.width = container.style.width || '50%';
                    container.style.justifySelf = container.style.justifySelf || 'center';
                }

                parent.appendChild(container);

                return;
            }

            if (item.type === 'text') {
                const text = document.createElement('div');
                text.style.boxSizing = 'border-box';

                if (item.id) {
                    text.dataset.layoutId = item.id;

                    if (item.id === 'pagination') {
                        text.dataset.pagination = 'true';
                    }
                }

                applyElementCommonStyle(config, text, item.style, item.type);

                // The comment box keeps the user's line breaks and wraps long words; it is split
                // across pages by `splitCommentAcrossPages`.
                if (item.id === 'comment_text') {
                    text.dataset.commentText = 'true';
                    text.style.whiteSpace = text.style.whiteSpace || 'break-spaces';
                    text.style.wordBreak = text.style.wordBreak || 'break-word';
                }

                text.textContent = replaceTemplateVars(item.value, templateVariables);

                parent.appendChild(text);

                return;
            }

            if (item.type === 'image') {
                const imageSrc = templateVariables[item.id];

                if (imageSrc) {
                    const img = document.createElement('img');

                    if (item.id) {
                        img.dataset.layoutId = item.id;
                    }

                    applyElementCommonStyle(config, img, item.style, item.type);

                    // IMPORTANT: Set crossOrigin BEFORE src for Safari compatibility
                    img.crossOrigin = 'anonymous';
                    img.alt = item.id || 'image';
                    img.src = replaceTemplateVars(item.value, templateVariables);
                    // img.style.maxHeight = img.style.maxHeight || '100%';
                    // img.style.maxWidth = img.style.maxWidth || '100%';
                    // img.style.backgroundColor = img.style.backgroundColor || 'transparent';

                    parent.appendChild(img);
                } else {
                    const placeholder = document.createElement('div');

                    if (item.id) {
                        placeholder.dataset.layoutId = item.id;
                    }

                    applyElementCommonStyle(config, placeholder, item.style, item.type);

                    parent.appendChild(placeholder);
                }

                return;
            }

            if (item.type === 'table') {
                renderTable(config, item, parent, templateVariables);
            }
        });
    };

    const buildSection = (
        config: TPrintPDFConfig,
        section: TPrintPDFConfig['header'],
        sectionName: 'header' | 'body' | 'footer',
        templateVariables: Record<string, any>,
        doc: Document
    ): HTMLElement => {
        const el = doc.createElement('div');
        el.dataset.section = sectionName;

        if (section?.style) {
            applyElementCommonStyle(config, el, section.style, 'container');
        }

        if (section?.height) {
            el.style.height = section.height;
        }

        if (!isEmpty(section?.items)) {
            renderLayoutItemsToHtml(config, section.items, el, templateVariables);
        }

        return el;
    };

    const ensureFontStyleInjected = () => {
        const styleId = 'print-preview-embedded-fonts';

        if (!fontData || document.getElementById(styleId)) {
            return;
        }

        const styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = buildSlimFontCss(fontData);
        document.head.appendChild(styleEl);
    };

    const waitForFontsReady = async (timeoutMs = 5000): Promise<void> => {
        const startTime = Date.now();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (!ctx) {
            return;
        }

        const testText = 'あ漢字ABC123日本語';

        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                ctx.font = '400 16px sans-serif';
                const fallbackWidth = ctx.measureText(testText).width;

                ctx.font = '400 16px "Noto Sans JP", sans-serif';
                const notoWidth = ctx.measureText(testText).width;

                const isLoaded = Math.abs(notoWidth - fallbackWidth) >= 1;

                if (isLoaded || Date.now() - startTime > timeoutMs) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 50);
        });
    };

    // Resolves once every <img> under `root` has loaded (or failed) and been decoded, so canvas
    // capture never sees a blank image; gives up after `timeoutMs` rather than hang the export.
    const waitForImagesLoaded = (root: HTMLElement, timeoutMs = IMAGE_LOAD_TIMEOUT_MS): Promise<void> => {
        const imgEls = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];

        if (!imgEls.length) {
            return Promise.resolve();
        }

        const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

        const waiters = imgEls.map(async (img) => {
            // CRITICAL for Safari: Set attributes before checking completion
            if (!img.crossOrigin) {
                img.crossOrigin = 'anonymous';
            }

            if (!img.decoding) {
                img.decoding = 'sync';
            }

            // If already loaded with valid dimensions, decode it for Safari
            if (img.complete && img.naturalWidth > 0) {
                try {
                    await img.decode();
                } catch (error) {
                    logError('[PrintPreview] Image decode failed', error);
                }

                return;
            }

            await new Promise<void>((resolve) => {
                const done = async () => {
                    img.removeEventListener('load', done);
                    img.removeEventListener('error', done);

                    // Force decode on load for Safari
                    if (img.naturalWidth > 0) {
                        try {
                            await img.decode();
                        } catch (error) {
                            logError('[PrintPreview] Image decode on load failed', error);
                        }
                    }

                    resolve();
                };

                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
            });
        });

        return Promise.race([Promise.all(waiters).then(() => undefined), timeout]);
    };

    // Rasterizes every page of the PDF to a JPEG blob URL, in page order. The caller owns the
    // URLs and must call `revoke` once the export is done.
    const convertPdfToImages = async (pdfFile: Blob): Promise<{ imageUrls: string[]; revoke: () => void }> => {
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await pdfFile.arrayBuffer()) }).promise;
        const pageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1);

        const results = await Promise.all(
            pageNumbers.map(async (pageNumber) => {
                const page = await pdf.getPage(pageNumber);
                const viewport = page.getViewport({ scale: PDF_PAGE_RENDER_SCALE });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');

                if (!context) {
                    return null;
                }

                canvas.width = viewport.width;
                canvas.height = viewport.height;

                await page.render({ canvasContext: context, viewport, canvas }).promise;

                const blob = await new Promise<Blob | null>((resolve) =>
                    canvas.toBlob(resolve, 'image/jpeg', PDF_PAGE_JPEG_QUALITY)
                );

                return blob ? URL.createObjectURL(blob) : null;
            })
        );

        const imageUrls = results.filter((url): url is string => url !== null);

        return { imageUrls, revoke: () => imageUrls.forEach((url) => URL.revokeObjectURL(url)) };
    };

    const updatePaginationText = (pageEl: HTMLElement, current: number, total: number): void => {
        const paginationEl = pageEl.querySelector('[data-pagination="true"]');

        if (paginationEl) {
            paginationEl.textContent = `${current} / ${total}`;
        }
    };

    const getSectionGapPx = (el: HTMLElement): number => {
        const style = window.getComputedStyle(el);
        const gap = parseFloat(style.rowGap || style.gap || '0');

        return Number.isNaN(gap) ? 0 : gap;
    };

    const getAvailableBodyHeightPx = (pageEl: HTMLElement, headerEl?: HTMLElement, footerEl?: HTMLElement): number => {
        const pageStyle = window.getComputedStyle(pageEl);
        const paddingTop = parseFloat(pageStyle.paddingTop || '0');
        const paddingBottom = parseFloat(pageStyle.paddingBottom || '0');
        const headerHeight = headerEl?.offsetHeight ?? 0;
        const footerHeight = footerEl?.offsetHeight ?? 0;

        return pageEl.clientHeight - paddingTop - paddingBottom - headerHeight - footerHeight;
    };

    // Measures against the page's current header/footer. Call it while the body isn't overflowing:
    // an overflowing body makes the flex column shrink the footer, which inflates the result.
    const getBodyAvailableHeightPx = (bodyEl: HTMLElement): number => {
        const pageEl = bodyEl.parentElement as HTMLElement;
        const headerEl = pageEl.querySelector<HTMLElement>(':scope > [data-section="header"]') ?? undefined;
        const footerEl = pageEl.querySelector<HTMLElement>(':scope > [data-section="footer"]') ?? undefined;

        return getAvailableBodyHeightPx(pageEl, headerEl, footerEl);
    };

    // Height taken by a body's stacked children, including the flex gaps between them.
    const getUsedBodyHeight = (bodyEl: HTMLElement, gapPx: number): number => {
        const children = Array.from(bodyEl.children) as HTMLElement[];
        const content = children.reduce((sum, child) => sum + child.offsetHeight, 0);
        const gaps = children.length > 0 ? (children.length - 1) * gapPx : 0;

        return content + gaps;
    };

    const createPageEl = (
        pageWidth: number,
        pageHeight: number,
        margins?: TPrintPDFPageSettings['margins']
    ): HTMLElement => {
        const page = document.createElement('div');
        page.dataset.printPreviewPage = 'true';
        page.style.width = `${pageWidth}mm`;
        page.style.height = `${pageHeight}mm`;
        page.style.boxSizing = 'border-box';
        page.style.background = 'white';
        page.style.paddingTop = margins?.top || '0';
        page.style.paddingBottom = margins?.bottom || '0';
        page.style.paddingLeft = margins?.left || '0';
        page.style.paddingRight = margins?.right || '0';
        page.style.display = 'flex';
        page.style.flexDirection = 'column';

        return page;
    };

    /**
     * Splits an overflowing body item's dynamic-row table across as many continuation
     * pages as needed — repeats the table's header row on every continuation chunk, but
     * only repeats the section's own title (bullet + label) on the first chunk.
     */
    const splitDynamicTableAcrossPages = (
        sectionEl: HTMLElement,
        tableEl: HTMLTableElement,
        currentBodyEl: HTMLElement,
        gapPx: number,
        availableHeight: number,
        createContinuationPage: () => { bodyEl: HTMLElement; availableHeight: number }
    ): { bodyEl: HTMLElement; availableHeight: number } => {
        const theadEl = tableEl.querySelector('thead');
        const tbodyEl = tableEl.querySelector('tbody');
        const rows = tbodyEl ? (Array.from(tbodyEl.rows) as HTMLTableRowElement[]) : [];
        const titleEls = Array.from(sectionEl.children).filter((child) => child !== tableEl) as HTMLElement[];
        const maxRowsPerPage = Number(tableEl.dataset.maxRowsPerPage) || Infinity;

        let bodyEl = currentBodyEl;
        let pageAvailableHeight = availableHeight;
        let chunkTbodyEl: HTMLTableSectionElement | null = null;
        let isFirstChunk = true;

        const startChunk = (): void => {
            const chunkSectionEl = sectionEl.cloneNode(false) as HTMLElement;

            if (isFirstChunk) {
                titleEls.forEach((el) => chunkSectionEl.appendChild(el.cloneNode(true) as HTMLElement));
            }

            const chunkTableEl = tableEl.cloneNode(false) as HTMLTableElement;

            if (theadEl) {
                chunkTableEl.appendChild(theadEl.cloneNode(true));
            }

            chunkTbodyEl = document.createElement('tbody');
            chunkTableEl.appendChild(chunkTbodyEl);
            chunkSectionEl.appendChild(chunkTableEl);
            bodyEl.appendChild(chunkSectionEl);
        };

        startChunk();

        rows.forEach((row) => {
            const rowClone = row.cloneNode(true) as HTMLTableRowElement;
            chunkTbodyEl?.appendChild(rowClone);

            const exceedsRowCap = (chunkTbodyEl?.rows.length ?? 0) > maxRowsPerPage;

            if (getUsedBodyHeight(bodyEl, gapPx) <= pageAvailableHeight && !exceedsRowCap) {
                return;
            }

            const hasOtherRows = (chunkTbodyEl?.rows.length ?? 0) > 1;

            if (!hasOtherRows) {
                // A single row alone doesn't fit even on an empty page — nothing left to split, keep it as-is.
                return;
            }

            chunkTbodyEl?.removeChild(rowClone);

            const next = createContinuationPage();
            bodyEl = next.bodyEl;
            pageAvailableHeight = next.availableHeight;
            isFirstChunk = false;
            startChunk();
            chunkTbodyEl?.appendChild(rowClone);
        });

        return { bodyEl, availableHeight: pageAvailableHeight };
    };

    const findCommentTextEl = (el: HTMLElement): HTMLElement | null =>
        el.matches(COMMENT_TEXT_SELECTOR) ? el : el.querySelector<HTMLElement>(COMMENT_TEXT_SELECTOR);

    // Clone of the comment item for a continuation page: only the comment box and the
    // containers wrapping it are kept, so the comment title is not repeated.
    const buildCommentContinuationChunk = (itemEl: HTMLElement): HTMLElement => {
        const chunkEl = itemEl.cloneNode(true) as HTMLElement;
        const textEl = findCommentTextEl(chunkEl);

        const prune = (node: HTMLElement) => {
            (Array.from(node.children) as HTMLElement[]).forEach((child) => {
                if (child === textEl) {
                    return;
                }

                if (textEl && child.contains(textEl)) {
                    prune(child);

                    return;
                }

                child.remove();
            });
        };

        if (textEl && textEl !== chunkEl) {
            prune(chunkEl);
        }

        return chunkEl;
    };

    // Binary-searches the longest comment slice starting at `start` that still fits the page.
    // Returns `start` when not even one character fits.
    const findFittingCommentEnd = (
        textEl: HTMLElement,
        fullText: string,
        start: number,
        fits: () => boolean
    ): number => {
        let low = start + 1;
        let high = fullText.length;
        let best = start;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            textEl.textContent = fullText.slice(start, mid);

            if (fits()) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        return best;
    };

    /**
     * Places the body item holding the comment box, splitting the comment text across as
     * many continuation pages as needed. The item's other content (e.g. the comment title)
     * only stays on the first chunk. When the first chunk would get less than
     * `COMMENT_MIN_FIRST_CHUNK_HEIGHT_PX`, the whole item starts on the next page instead.
     */
    const splitCommentAcrossPages = (
        itemEl: HTMLElement,
        currentBodyEl: HTMLElement,
        gapPx: number,
        availableHeight: number,
        createContinuationPage: () => { bodyEl: HTMLElement; availableHeight: number }
    ): { bodyEl: HTMLElement; availableHeight: number } => {
        const fullText = findCommentTextEl(itemEl)?.textContent ?? '';

        let bodyEl = currentBodyEl;
        let pageAvailableHeight = availableHeight;
        let start = 0;
        let isFirstChunk = true;

        const moveToNextPage = () => {
            ({ bodyEl, availableHeight: pageAvailableHeight } = createContinuationPage());
        };

        for (let chunkCount = 0; chunkCount < COMMENT_MAX_CHUNKS; chunkCount++) {
            const fitLimit = getBodyAvailableHeightPx(bodyEl) - COMMENT_RENDER_SAFETY_PX;
            const chunkEl = isFirstChunk ? itemEl : buildCommentContinuationChunk(itemEl);
            const textEl = findCommentTextEl(chunkEl);
            bodyEl.appendChild(chunkEl);

            if (!textEl) {
                return { bodyEl, availableHeight: pageAvailableHeight };
            }

            if (!isFirstChunk && parseFloat(window.getComputedStyle(textEl).marginTop || '0') === 0) {
                textEl.style.marginTop = COMMENT_CONTINUATION_MARGIN_TOP;
            }

            const fits = () =>
                getUsedBodyHeight(bodyEl, gapPx) <= fitLimit &&
                textEl.scrollHeight <= textEl.clientHeight + PAGE_OVERFLOW_EPSILON_PX;
            const hasOtherItems = bodyEl.children.length > 1;

            textEl.textContent = '';
            const roomForText = fitLimit - getUsedBodyHeight(bodyEl, gapPx);

            if (isFirstChunk && hasOtherItems && roomForText < COMMENT_MIN_FIRST_CHUNK_HEIGHT_PX) {
                bodyEl.removeChild(chunkEl);
                moveToNextPage();
                continue;
            }

            const remainingText = fullText.slice(start);
            textEl.textContent = remainingText;

            if (fits()) {
                return { bodyEl, availableHeight: pageAvailableHeight };
            }

            const end = findFittingCommentEnd(textEl, fullText, start, fits);

            if (end <= start) {
                if (hasOtherItems) {
                    bodyEl.removeChild(chunkEl);
                    moveToNextPage();
                    continue;
                }

                // Not even one character fits on an empty page — keep the rest here rather than loop forever.
                textEl.textContent = remainingText;

                return { bodyEl, availableHeight: pageAvailableHeight };
            }

            textEl.textContent = fullText.slice(start, end);
            start = end;
            isFirstChunk = false;
            moveToNextPage();
        }

        // Safety fallback: never drop comment text even if the chunk limit is hit.
        const restEl = buildCommentContinuationChunk(itemEl);
        const restTextEl = findCommentTextEl(restEl);

        if (restTextEl) {
            restTextEl.textContent = fullText.slice(start);
        }

        bodyEl.appendChild(restEl);

        return { bodyEl, availableHeight: pageAvailableHeight };
    };

    /**
     * Stretches the last comment box down to the footer so the printed comment frame closes
     * at the bottom of the final page. Skipped when other body items follow the comment.
     */
    const stretchLastCommentBox = (pages: HTMLElement[]): void => {
        const textEls = pages.flatMap((pageEl) => Array.from(pageEl.querySelectorAll<HTMLElement>(COMMENT_TEXT_SELECTOR)));
        const lastTextEl = textEls[textEls.length - 1];
        const bodyEl = lastTextEl?.closest<HTMLElement>('[data-section="body"]');

        if (!lastTextEl || !bodyEl || !bodyEl.lastElementChild?.contains(lastTextEl)) {
            return;
        }

        const remainingHeight =
            getBodyAvailableHeightPx(bodyEl) -
            getUsedBodyHeight(bodyEl, getSectionGapPx(bodyEl)) -
            COMMENT_RENDER_SAFETY_PX -
            COMMENT_BOTTOM_GAP_PX;

        if (remainingHeight > 0) {
            lastTextEl.style.minHeight = `${Math.floor(lastTextEl.offsetHeight + remainingHeight)}px`;
        }
    };

    /**
     * Redistributes the first page's already-rendered top-level body items across
     * continuation pages so none of them are cropped off the bottom of the page.
     */
    const paginateBodyItems = (
        firstBodyEl: HTMLElement,
        itemEls: HTMLElement[],
        gapPx: number,
        initialAvailableHeight: number,
        createContinuationPage: () => { bodyEl: HTMLElement; availableHeight: number }
    ): void => {
        firstBodyEl.replaceChildren();

        let bodyEl = firstBodyEl;
        let availableHeight = initialAvailableHeight;

        const exceedsRowCap = (el: HTMLElement): boolean => {
            const table = el.querySelector('table[data-max-rows-per-page]') as HTMLTableElement | null;

            if (!table) {
                return false;
            }

            const maxRowsPerPage = Number(table.dataset.maxRowsPerPage);
            const rowCount = table.querySelector('tbody')?.rows.length ?? 0;

            return maxRowsPerPage > 0 && rowCount > maxRowsPerPage;
        };

        itemEls.forEach((el) => {
            // The comment box always goes through its own placement, even when it fits, so the
            // minimum-first-chunk rule applies.
            if (findCommentTextEl(el)) {
                const result = splitCommentAcrossPages(el, bodyEl, gapPx, availableHeight, createContinuationPage);

                bodyEl = result.bodyEl;
                availableHeight = result.availableHeight;

                return;
            }

            bodyEl.appendChild(el);

            if (getUsedBodyHeight(bodyEl, gapPx) <= availableHeight && !exceedsRowCap(el)) {
                return;
            }

            const dynamicTable = el.querySelector('table[data-dynamic-rows="true"]') as HTMLTableElement | null;

            // Try splitting a direct-child dynamic table FIRST, filling whatever room is left on
            // the current page before spilling to a continuation page — bumping the whole item
            // straight to a new page (below) would strand the current page's remaining space as
            // a blank gap even though part of this item's rows could still fit here.
            if (dynamicTable && dynamicTable.parentElement === el) {
                bodyEl.removeChild(el);

                const result = splitDynamicTableAcrossPages(
                    el,
                    dynamicTable,
                    bodyEl,
                    gapPx,
                    availableHeight,
                    createContinuationPage
                );

                bodyEl = result.bodyEl;
                availableHeight = result.availableHeight;

                return;
            }

            const isOnlyItem = bodyEl.children.length === 1;

            if (!isOnlyItem) {
                bodyEl.removeChild(el);

                const next = createContinuationPage();
                bodyEl = next.bodyEl;
                availableHeight = next.availableHeight;
                bodyEl.appendChild(el);
            }

            // Otherwise: no splittable table directly inside this item — best effort, leave it
            // as a whole block (possibly still overflowing the page it landed on).
        });
    };

    const buildPrintablePages = async (
        config: TPrintPDFConfig,
        formValues: TPrintPreviewForm,
        pdfImageUrls: string[] = []
    ): Promise<{
        pageWidth: number;
        pageHeight: number;
        pages: HTMLElement[];
        cleanup: () => void;
    }> => {
        ensureFontStyleInjected();

        const templateVariables = buildTemplateVariables(formValues, pdfImageUrls[0]);
        const pageSettings = config.pageSettings;
        const { pageWidth, pageHeight } = getPageSizeMm({ ...pageSettings, orientation: 'portrait' });
        const margins = pageSettings?.margins;

        const root = document.createElement('div');
        root.dataset.printPreviewRoot = 'true';
        root.style.position = 'fixed';
        root.style.left = '-99999px';
        root.style.top = '0';
        root.style.zIndex = '-9999';
        root.style.pointerEvents = 'none';
        document.body.appendChild(root);

        const pages: HTMLElement[] = [];

        // By default only the first page repeats the clinic/title header; a config can opt into
        // repeating it on every continuation page via `header.repeatOnEveryPage`.
        const buildShell = (
            isFirstPage: boolean
        ): { pageEl: HTMLElement; headerEl?: HTMLElement; bodyEl: HTMLElement; footerEl?: HTMLElement } => {
            const pageEl = createPageEl(pageWidth, pageHeight, margins);

            let headerEl: HTMLElement | undefined;

            if ((isFirstPage || config.header?.repeatOnEveryPage) && !isEmpty(config.header)) {
                headerEl = buildSection(config, config.header, 'header', templateVariables, document);
                pageEl.appendChild(headerEl);
            }

            const bodyEl = buildSection(config, { style: config.body?.style }, 'body', templateVariables, document);
            bodyEl.style.flex = bodyEl.style.flex || '1 1 auto';
            pageEl.appendChild(bodyEl);

            let footerEl: HTMLElement | undefined;

            if (!isEmpty(config.footer)) {
                footerEl = buildSection(config, config.footer, 'footer', templateVariables, document);
                pageEl.appendChild(footerEl);
            }

            root.appendChild(pageEl);

            return { pageEl, headerEl, bodyEl, footerEl };
        };

        const first = buildShell(true);
        first.pageEl.id = PrintPDFElementId;
        pages.push(first.pageEl);

        const bodyItems = config.body?.items ?? [];
        renderLayoutItemsToHtml(config, bodyItems, first.bodyEl, templateVariables);

        // Content layout: every further PDF page gets its own full page (header included) showing it as `image_1`.
        if (isContentLayout) {
            pdfImageUrls.slice(1).forEach((pdfImageUrl) => {
                const shell = buildShell(true);
                pages.push(shell.pageEl);
                renderLayoutItemsToHtml(
                    config,
                    bodyItems,
                    shell.bodyEl,
                    buildTemplateVariables(formValues, pdfImageUrl)
                );
            });
        }

        // Images drive the body height, so they must be loaded before anything is measured.
        await waitForImagesLoaded(root);
        await waitForFontsReady();

        const extraDelay = detectSafari() || detectIPad() ? 500 : 200;
        await new Promise((resolve) => setTimeout(resolve, extraDelay));

        // The Content layout is one printed page per PDF page and is never re-paginated.
        if (!isContentLayout) {
            // Conservative on purpose: continuation pages have no header so they actually have more
            // room than this, but reusing the first page's (smaller) budget everywhere is always safe.
            const availableHeight = getAvailableBodyHeightPx(first.pageEl, first.headerEl, first.footerEl);
            const hasRowCapOverflow = Array.from(first.bodyEl.querySelectorAll('table[data-max-rows-per-page]')).some(
                (table) => {
                    const maxRowsPerPage = Number((table as HTMLTableElement).dataset.maxRowsPerPage);
                    const rowCount = table.querySelector('tbody')?.rows.length ?? 0;

                    return maxRowsPerPage > 0 && rowCount > maxRowsPerPage;
                }
            );
            const isOverflowing =
                first.bodyEl.scrollHeight > availableHeight + PAGE_OVERFLOW_EPSILON_PX || hasRowCapOverflow;
            const hasComment = Boolean(first.bodyEl.querySelector(COMMENT_TEXT_SELECTOR));

            if ((isOverflowing || hasComment) && bodyItems.length > 0) {
                const itemEls = Array.from(first.bodyEl.children) as HTMLElement[];
                const gapPx = getSectionGapPx(first.bodyEl);

                paginateBodyItems(first.bodyEl, itemEls, gapPx, availableHeight, () => {
                    const shell = buildShell(false);
                    pages.push(shell.pageEl);

                    return {
                        bodyEl: shell.bodyEl,
                        availableHeight: getAvailableBodyHeightPx(shell.pageEl, shell.headerEl, shell.footerEl)
                    };
                });
            }

            stretchLastCommentBox(pages);
        }

        pages.forEach((pageEl, index) => updatePaginationText(pageEl, index + 1, pages.length));

        const cleanup = () => {
            if (root.parentElement) {
                root.parentElement.removeChild(root);
            }
        };

        return { pageWidth, pageHeight, pages, cleanup };
    };

    const applyPDFViewer = async (formValues: TPrintPreviewForm, pdfFile?: Blob) => {
        let revokePdfImageUrls: (() => void) | undefined;

        try {
            document
                .querySelectorAll('[data-print-preview-page="true"], [data-print-preview-root="true"]')
                .forEach((el) => el.remove());

            const config = await loadLocalConfig();

            if (!config) {
                return undefined;
            }

            // Content layout with an attached PDF: each PDF page is printed as `image_1` on its own page.
            let pdfImageUrls: string[] = [];

            if (pdfFile && isContentLayout) {
                const result = await convertPdfToImages(pdfFile);
                pdfImageUrls = result.imageUrls;
                revokePdfImageUrls = result.revoke;
            }

            const { pageWidth, pageHeight, pages, cleanup } = await buildPrintablePages(
                config,
                formValues,
                pdfImageUrls
            );

            const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [pageWidth, pageHeight] });
            const pageHtmls: string[] = [];

            // Convert blob URLs to base64 data URLs before canvas rendering
            // Canvas cannot access blob URLs from different document contexts
            const blobToDataUrl = async (blobUrl: string): Promise<string> => {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.naturalWidth;
                        canvas.height = img.naturalHeight;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) {
                            reject(new Error('Failed to get canvas context'));

                            return;
                        }
                        ctx.drawImage(img, 0, 0);
                        resolve(canvas.toDataURL('image/jpeg', 0.85));
                    };
                    img.onerror = () => reject(new Error(`Failed to load blob URL: ${blobUrl}`));
                    img.src = blobUrl;
                });
            };

            const conversionPromises = pages.map(async (pageEl, i) => {
                const imgInPage = pageEl.querySelector('img[data-layout-id="image_1"]') as HTMLImageElement;
                if (imgInPage && imgInPage.src.startsWith('blob:')) {
                    try {
                        const dataUrl = await blobToDataUrl(imgInPage.src);
                        imgInPage.src = dataUrl;
                        // The swapped src reloads asynchronously; capture must not start before it has.
                        await waitForImagesLoaded(pageEl);

                        return { success: true, page: i };
                    } catch (error) {
                        logError('[PrintPreview] Failed to convert blob to base64 for page', i, error);

                        return { success: false, page: i };
                    }
                }

                return { success: true, page: i };
            });
            await Promise.all(conversionPromises);

            for (let index = 0; index < pages.length; index++) {
                const pageEl = pages[index];

                if (index > 0) {
                    pdf.addPage([pageWidth, pageHeight], 'portrait');
                }

                const canvas = await withTimeout(
                    canvasToImage.toCanvas(pageEl, {
                        pixelRatio: 3,
                        fontStyles: document.getElementById('print-preview-embedded-fonts') as HTMLElement
                    }),
                    CANVAS_RENDER_TIMEOUT_MS
                );

                const dataUrl = canvas.toDataURL('image/jpeg', 1);
                pdf.addImage(dataUrl, 'JPEG', 0, 0, pageWidth, pageHeight);
                pageHtmls.push(pageEl.outerHTML);
            }

            const pdfBlob = pdf.output('blob');

            cleanup();

            return { pdfBlob, pageHtmls };
        } catch (error) {
            logError('[PrintPreview] Failed to build PDF', error);

            return undefined;
        } finally {
            revokePdfImageUrls?.();
        }
    };

    return {
        applyPDFViewer
    };
};

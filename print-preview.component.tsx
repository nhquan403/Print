import './print-preview.component.css';

import { Comment } from '@components/comment';
import { Button, Dialog, Form, PDFViewer, Radio, useLoading, useMessageDialog } from '@lib/components';
import { classNames, delay, logError } from '@lib/utils';
import { Fragment, memo, ReactNode, useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PrintPDFLayoutType } from './print-preview.const';
import { TPrintPDFImage, TPrintPreviewForm } from './print-preview.model';
import { usePrintPreviewService } from './print-preview.service';
import PrintPreviewTesting from './testing/print-preview.testing';

const ORIENTATION_OPTIONS = [{ label: 'app.PRINT_PREVIEW_003', value: 'portrait' }];
const SHOW_RESULT_OPTIONS = [
    { label: 'app.PRINT_PREVIEW_012', value: 'aiResultOnly' },
    { label: 'app.PRINT_PREVIEW_013', value: 'allResults' }
];
const DISABLED_ALL_RESULTS_OPTIONS = SHOW_RESULT_OPTIONS.map((option) => ({
    ...option,
    disabled: option.value === 'allResults'
}));

interface IProps {
    openned?: boolean;
    layoutType: PrintPDFLayoutType;
    data?: Record<string, unknown>;
    /** Bound in order to the config's `image_1`, `image_2`, … items (and `image_N_date`). Keep the reference stable. */
    images?: TPrintPDFImage[];
    /** Content layout only: every page of this PDF is printed as `image_1` on its own page. */
    pdfFile?: Blob;
    defaultTitle?: string;
    className?: string;
    disableAllResults?: boolean;
    close?: () => void;
    /** Custom save behavior (e.g. upload to server). Falls back to a local browser download when omitted. */
    onSavePdf?: (pdfBlob: Blob) => Promise<void>;
}

const PrintPreview = ({
    openned,
    layoutType,
    data,
    images,
    pdfFile,
    defaultTitle,
    className,
    disableAllResults = false,
    close,
    onSavePdf
}: IProps) => {
    const { t } = useTranslation();
    const printPreviewService = usePrintPreviewService(layoutType, data, images);
    const [searchParams] = useSearchParams();
    const messageDialog = useMessageDialog();
    const loading = useLoading();

    const [buildingPDF, setBuildingPDF] = useState(false);
    const [savingPDF, setSavingPDF] = useState(false);
    const [generatedPdfBlob, setGeneratedPdfBlob] = useState<Blob | null>(null);

    const formHook = useForm<TPrintPreviewForm>({
        mode: 'onBlur',
        defaultValues: {
            orientation: 'portrait',
            resultType: 'aiResultOnly',
            title: defaultTitle?.trim() || t('app.PRINT_PREVIEW_010'),
            comment: ''
        }
    });

    // Dev-only: inspect the raw HTML page used to build the PDF, without going through canvas/PDF rasterization.
    const [isTestingOpenned, setIsTestingOpenned] = useState(false);
    const [testingElements, setTestingElements] = useState<ReactNode[]>([]);
    const shouldShowTestingButton =
        searchParams.get('testingMode') === 'true' && ['dev', 'test', 'local'].includes(window.env.VITE_ENV);
    const [appliedFormValues, setAppliedFormValues] = useState<TPrintPreviewForm>(formHook.getValues());

    const isSubkarteLayout = layoutType === PrintPDFLayoutType.Subkarte;
    const isContentLayout = layoutType === PrintPDFLayoutType.Content;
    const shouldHideMetadataFields = isContentLayout;
    const shouldShowApplyButton = !shouldHideMetadataFields;

    const isShowFooter = shouldShowTestingButton || shouldShowApplyButton;

    const disabledForm = useMemo(() => {
        if (layoutType === PrintPDFLayoutType.Content || buildingPDF) {
            return true;
        }

        return false;
    }, [layoutType, buildingPDF]);

    const disabledCreatorAndComment = useMemo(() => {
        return disabledForm || layoutType === PrintPDFLayoutType.Subkarte;
    }, [disabledForm, layoutType]);

    const buildPdf = async (formValues: TPrintPreviewForm, isAppliedFormValues?: boolean) => {
        try {
            setBuildingPDF(true);
            // Let the dialog paint before the heavy canvas/PDF work starts.
            await delay(300);

            const result = await printPreviewService.applyPDFViewer(formValues, pdfFile);

            if (!result) {
                logError('[PrintPreview] applyPDFViewer returned undefined');

                return;
            }

            if (isAppliedFormValues) {
                setAppliedFormValues(formValues);
            }

            setGeneratedPdfBlob(result.pdfBlob);

            if (shouldShowTestingButton) {
                setTestingElements(
                    result.pageHtmls.map((pageHtml, index) => (
                        <div
                            key={`page-${index + 1}`}
                            className="flex items-center justify-center"
                            dangerouslySetInnerHTML={{ __html: pageHtml }}
                        />
                    ))
                );
            }
        } finally {
            setBuildingPDF(false);
        }
    };

    useEffect(() => {
        if (!openned) {
            return;
        }

        void buildPdf(formHook.getValues());
        // Rebuild only when the dialog opens or the source data/images change.
    }, [openned, data, images, pdfFile]);

    const validateActions = (title: string) => {
        if (appliedFormValues.comment !== formHook.getValues('comment') && !shouldHideMetadataFields) {
            messageDialog.confirm(t('app.MSG.DAICA-SE-WAR-001.CONTENT'), {
                header: t(title),
                closeBtnLabel: t('app.BTN_CLOSE'),
                closeAction: () => {}
            });

            return false;
        }

        return true;
    };

    const handlePrint = () => {
        if (!generatedPdfBlob) {
            return;
        }

        const handleOpenUrl = () => {
            const pdfUrl = URL.createObjectURL(generatedPdfBlob);
            const printWindow = window.open(pdfUrl, '_blank');

            if (!printWindow) {
                URL.revokeObjectURL(pdfUrl);

                return;
            }

            printWindow.onload = () => {
                printWindow.print();

                printWindow.onafterprint = () => {
                    URL.revokeObjectURL(pdfUrl);
                    printWindow.close();
                };
            };
        };

        messageDialog.confirm(t('app.MSG.DAICA-CMN-CFR-001.CONTENT'), {
            header: t('app.MSG.DAICA-CMN-CFR-001.TITLE'),
            acceptBtnLabel: t('app.BTN_YES'),
            closeBtnLabel: t('app.BTN_NO'),
            acceptAction: async () => {
                loading.show();
                handleOpenUrl();
                await handleSavePdf(true);
                loading.hide();
            },
            closeAction: () => {
                handleOpenUrl();
            }
        });
    };

    const handleSavePdf = async (isKeepLoading = false) => {
        if (!generatedPdfBlob) {
            return;
        }

        if (onSavePdf) {
            try {
                if (!isKeepLoading) {
                    setSavingPDF(true);
                    loading.show();
                }
                await onSavePdf(generatedPdfBlob);
            } finally {
                setSavingPDF(false);
                loading.hide();
            }

            return;
        }

        const fileName = formHook.getValues('title')?.trim() || t('app.PRINT_PREVIEW_010');
        const pdfUrl = URL.createObjectURL(generatedPdfBlob);
        const link = document.createElement('a');
        link.href = pdfUrl;
        link.download = `${fileName}.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(pdfUrl);
    };

    const handleClose = () => {
        setGeneratedPdfBlob(null);
        close?.();
    };

    return (
        <>
            <Dialog
                dialogId="print-preview-dialog"
                className={classNames('print-preview-dialog-wrapper', className)}
                visible={openned}
                headerTitle="app.PRINT_PREVIEW_001"
                isKeepPositionCloseTable
                onHide={handleClose}
            >
                <div
                    className="flex w-full flex-col-reverse lg:flex-row"
                    key="content"
                >
                    <PDFViewer
                        pdfFile={generatedPdfBlob}
                        isControlDisabled={buildingPDF}
                        loading={buildingPDF}
                        orientation="portrait"
                    />

                    <div className="print-preview-info">
                        <Form<TPrintPreviewForm>
                            formHook={formHook}
                            className="h-full min-h-0"
                        >
                            <div className="print-preview-form-fields">
                                <Radio
                                    layoutConfig={{ orientation: 'horizontal' }}
                                    name="orientation"
                                    label="app.PRINT_PREVIEW_002"
                                    labelColSpan={2}
                                    inputColSpan={10}
                                    size="md"
                                    rootClassName="radio-orientation"
                                    labelClassName="!mr-4 !text-14-medium !text-content-secondary"
                                    inputClassName="!mr-3"
                                    fieldClassName="!flex !items-center !gap-0"
                                    disabled={buildingPDF || ORIENTATION_OPTIONS.length <= 1}
                                    control={formHook.control}
                                    options={ORIENTATION_OPTIONS}
                                />

                                {!shouldHideMetadataFields && (
                                    <>
                                        <div className="separate-line" />

                                        <div>
                                            <p className="label-result-type">{t('app.PRINT_PREVIEW_011')}</p>
                                            <Radio
                                                layoutConfig={{ orientation: 'horizontal' }}
                                                name="resultType"
                                                inputColSpan={12}
                                                size="md"
                                                rootClassName="radio-result-type"
                                                value={formHook.getValues('resultType')}
                                                inputClassName="!mr-3 !flex !flex-col !items-start !gap-3"
                                                fieldClassName="!flex !flex-col !items-start !gap-3"
                                                disabled={buildingPDF || SHOW_RESULT_OPTIONS.length <= 1}
                                                control={formHook.control}
                                                options={
                                                    disableAllResults
                                                        ? DISABLED_ALL_RESULTS_OPTIONS
                                                        : SHOW_RESULT_OPTIONS
                                                }
                                                onChange={(e) => {
                                                    setAppliedFormValues({
                                                        ...appliedFormValues,
                                                        resultType: e
                                                    });
                                                    buildPdf({
                                                        ...appliedFormValues,
                                                        resultType: e
                                                    });
                                                    formHook.setValue('resultType', e);
                                                }}
                                            />
                                        </div>

                                        {!isSubkarteLayout && (
                                            <>
                                                <Controller
                                                    name="comment"
                                                    disabled={disabledCreatorAndComment}
                                                    control={formHook.control}
                                                    render={({ field }) => (
                                                        <Comment
                                                            inputClassName="preview-comment-input"
                                                            title="app.PRINT_PREVIEW_008"
                                                            placeHolder="app.PRINT_PREVIEW_009"
                                                            showAction={false}
                                                            maxLength={500}
                                                            rows={9}
                                                            autoResize={false}
                                                            isHaveIcon={true}
                                                            showCountCharacter={false}
                                                            content={field.value || ''}
                                                            disabled={disabledCreatorAndComment}
                                                            onChange={field.onChange}
                                                        />
                                                    )}
                                                />
                                            </>
                                        )}
                                    </>
                                )}
                            </div>
                        </Form>

                        {isShowFooter && (
                            <div className="print-preview-form-footer">
                                {shouldShowTestingButton && (
                                    <Button
                                        title="Test HTML"
                                        type="ghost"
                                        size="lg"
                                        disabled={buildingPDF}
                                        onClick={() => setIsTestingOpenned(true)}
                                    />
                                )}

                                {shouldShowApplyButton && (
                                    <Button
                                        title="app.BTN_PREVIEW_PDF"
                                        className="preview-btn preview-apply-btn"
                                        type="primary-outline"
                                        size="lg"
                                        disabled={buildingPDF}
                                        onClick={() => buildPdf(formHook.getValues(), true)}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                </div>

                <Fragment key="footer">
                    <Button
                        title="app.BTN_CLOSE"
                        type="secondary"
                        size="lg"
                        className="!text-content-strong"
                        onClick={handleClose}
                    />

                    <Button
                        title="app.BTN_PRINT"
                        type="primary"
                        size="lg"
                        disabled={!generatedPdfBlob || buildingPDF}
                        onClick={() => {
                            if (!validateActions("app.BTN_PRINT")) {
                                return;
                            }

                            handlePrint();
                        }}
                    />

                    <Button
                        title="app.BTN_SAVE_PDF"
                        type="primary"
                        size="lg"
                        loading={savingPDF}
                        disabled={!generatedPdfBlob || buildingPDF || savingPDF}
                        onClick={() => {
                            if (!validateActions("app.BTN_SAVE_PDF")) {
                                return;
                            }

                            void handleSavePdf();
                        }}
                    />
                </Fragment>
            </Dialog>

            {shouldShowTestingButton && isTestingOpenned && (
                <PrintPreviewTesting
                    openned={isTestingOpenned}
                    elements={testingElements}
                    close={() => setIsTestingOpenned(false)}
                />
            )}
        </>
    );
};

export default memo(PrintPreview);

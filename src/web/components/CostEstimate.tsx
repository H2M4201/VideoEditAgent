import { t } from '../i18n';
import type { PrepareResult, Settings } from '../api';

/** USD when prices are set (either price above 0), otherwise token counts. */
export function CostEstimate({ cost, settings }: { cost: PrepareResult['cost']; settings: Pick<Settings, 'inputPricePerMTok' | 'outputPricePerMTok'> }) {
  const priced = settings.inputPricePerMTok > 0 || settings.outputPricePerMTok > 0;
  return (
    <p>
      <strong>{t('estimatedCost')}:</strong>{' '}
      {priced ? `~$${cost.usd.toFixed(2)}` : t('tokens', { n: cost.inputTokens.toLocaleString('en-US') })}
    </p>
  );
}

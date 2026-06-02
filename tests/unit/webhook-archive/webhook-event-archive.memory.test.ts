import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { describeWebhookEventArchiveConformance } from '../../helpers/webhook-event-archive.conformance.js';

describeWebhookEventArchiveConformance('Memory', {
  factory: () => new WebhookEventArchiveMemory(),
});

import { z } from 'zod';

// Untrusted marketing metadata, never identity/auth evidence. No URLs with queries.
const field = z
  .string()
  .max(160)
  .refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
  .nullable();
export const SignupAttributionSchema = z.object({
  utm_source: field,
  utm_medium: field,
  utm_campaign: field,
  utm_term: field,
  utm_content: field,
  gclid: field,
  gbraid: field,
  wbraid: field,
  referrer: z
    .string()
    .max(400)
    .url()
    .refine((v) => /^https?:\/\//.test(v) && !/[?#]/.test(v))
    .nullable(),
  landing_path: z
    .string()
    .max(400)
    .regex(/^\/[^?#]*$/)
    .refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
  captured_at: z.string().datetime(),
});
export type SignupAttribution = z.infer<typeof SignupAttributionSchema>;
export const SIGNUP_ATTRIBUTION_KEY = 'eunenem:first_touch:v1';
export const SIGNUP_ATTRIBUTION_COOKIE = 'eunenem_first_touch';
export function parseSignupAttribution(value: string | null): SignupAttribution | null {
  if (!value || value.length > 3500) return null;
  try {
    const parsed = SignupAttributionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

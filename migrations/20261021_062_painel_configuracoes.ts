// Historical migration identifier retained because staging may have recorded it.
// Settings now uses only existing UI flows: no schema change is required.
// Never drop any tables or records created by an earlier staging deployment.
export async function up(): Promise<void> {}
export async function down(): Promise<void> {}

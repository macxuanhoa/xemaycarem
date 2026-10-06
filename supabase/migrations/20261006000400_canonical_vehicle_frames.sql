-- No data rewrite: fail migration if pre-existing canonical duplicates need review.
-- Enforce identity consistently for RPC, import and direct administrative writes.
CREATE UNIQUE INDEX vehicles_canonical_frame_unique
ON public.vehicles (upper(btrim(frame_number)))
WHERE btrim(frame_number) <> '';

-- Referencia única del comentario de Instagram (commentId del trigger igCommentOnPost),
-- para no duplicar comentarios si GHL reenvía el webhook. Solo aplica cuando hay commentId
-- (índice parcial: comment_ref vacío no colisiona con otros vacíos).
ALTER TABLE comments ADD COLUMN IF NOT EXISTS comment_ref TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_comments_ref ON comments (account_id, comment_ref) WHERE comment_ref <> '';

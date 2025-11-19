-- 修复 Responses API 请求的 Token 统计问题
-- 这个脚本会更新那些 total_tokens = 0 但实际有 usage 信息的记录

-- 注意：这个脚本假设 response_body 中包含了正确的 usage 信息
-- 由于 response_body 是 JSON 格式，我们需要解析它来提取 token 信息

-- 查看需要修复的记录数量
SELECT 
    COUNT(*) as records_to_fix,
    GROUP_CONCAT(DISTINCT model) as affected_models
FROM api_requests
WHERE status = 'success' 
    AND total_tokens = 0
    AND response_body IS NOT NULL
    AND response_body LIKE '%"usage"%';

-- 如果你确认要修复这些记录，可以运行以下更新语句
-- 注意：这个更新语句需要 MySQL 5.7.8+ 支持 JSON 函数

-- 备份建议：在运行更新前，先备份 api_requests 表
-- CREATE TABLE api_requests_backup AS SELECT * FROM api_requests WHERE total_tokens = 0;

-- 更新语句（需要根据实际的 JSON 结构调整）
-- 由于 response_body 可能包含 Responses API 格式的 usage (input_tokens/output_tokens)
-- 或标准格式的 usage (prompt_tokens/completion_tokens)

-- 方案1：如果你的 MySQL 版本支持 JSON 函数（推荐）
/*
UPDATE api_requests
SET 
    prompt_tokens = COALESCE(
        JSON_EXTRACT(response_body, '$.usage.input_tokens'),
        JSON_EXTRACT(response_body, '$.usage.prompt_tokens'),
        0
    ),
    completion_tokens = COALESCE(
        JSON_EXTRACT(response_body, '$.usage.output_tokens'),
        JSON_EXTRACT(response_body, '$.usage.completion_tokens'),
        0
    ),
    total_tokens = COALESCE(
        JSON_EXTRACT(response_body, '$.usage.total_tokens'),
        JSON_EXTRACT(response_body, '$.usage.input_tokens') + JSON_EXTRACT(response_body, '$.usage.output_tokens'),
        JSON_EXTRACT(response_body, '$.usage.prompt_tokens') + JSON_EXTRACT(response_body, '$.usage.completion_tokens'),
        0
    )
WHERE status = 'success' 
    AND total_tokens = 0
    AND response_body IS NOT NULL
    AND response_body LIKE '%"usage"%';
*/

-- 方案2：如果 JSON 函数不可用，建议手动处理或使用应用层脚本

-- 验证修复结果
SELECT 
    COUNT(*) as remaining_zero_tokens,
    GROUP_CONCAT(DISTINCT model) as still_affected_models
FROM api_requests
WHERE status = 'success' 
    AND total_tokens = 0
    AND created_at >= (UNIX_TIMESTAMP() * 1000 - 24 * 60 * 60 * 1000);
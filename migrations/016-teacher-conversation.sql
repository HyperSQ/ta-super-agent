CREATE INDEX IF NOT EXISTS events_conversation_owner ON events(course_id, json_extract(data,'$.conversationOwner'));
CREATE INDEX IF NOT EXISTS deliveries_conversation_event ON deliveries(json_extract(data,'$.replyEventId'));
CREATE INDEX IF NOT EXISTS tasks_conversation_event ON tasks(json_extract(data,'$.grant.originEventId'));

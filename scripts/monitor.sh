#!/bin/bash
# NanoClaw Monitoring Script

case "$1" in
  status)
    echo "=== Service Status ==="
    if launchctl list | grep -q com.nanoclaw; then
      PID=$(launchctl list | grep nanoclaw | awk '{print $1}')
      echo "✅ Running (PID: $PID)"
      echo ""
      echo "Recent activity:"
      tail -10 logs/nanoclaw.log | grep -E "(INFO|WARN|ERROR)" | tail -5
    else
      echo "❌ Not running"
    fi
    ;;

  groups)
    echo "=== Registered Groups ==="
    sqlite3 store/messages.db << SQL
SELECT
  printf('%-20s %-10s %s', name,
    CASE
      WHEN jid LIKE '%@g.us' THEN 'WhatsApp'
      WHEN jid LIKE 'feishu:%' THEN 'Feishu'
      ELSE 'Other'
    END,
    trigger_pattern
  ) as info
FROM registered_groups
ORDER BY name;
SQL
    ;;

  channels)
    echo "=== Channel Status ==="
    echo "Checking logs for connection status..."
    echo ""
    echo "Feishu:"
    grep -i "feishu.*connect" logs/nanoclaw.log | tail -2
    echo ""
    echo "WhatsApp:"
    grep -i "whatsapp.*connect\|Connection is now" logs/nanoclaw.log | tail -2
    ;;

  activity)
    echo "=== Recent Activity (last 10 messages) ==="
    sqlite3 store/messages.db << SQL
SELECT
  datetime(timestamp, 'localtime') as time,
  substr(sender_name, 1, 15) as sender,
  substr(content, 1, 60) || '...' as message
FROM messages
ORDER BY timestamp DESC
LIMIT 10;
SQL
    ;;

  logs)
    echo "Following logs (Ctrl+C to stop)..."
    tail -f logs/nanoclaw.log
    ;;

  errors)
    echo "=== Recent Errors ==="
    grep -i error logs/nanoclaw.log | tail -20
    ;;

  *)
    echo "NanoClaw Monitor"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  status    - Service status and recent activity"
    echo "  groups    - List registered groups"
    echo "  channels  - Channel connection status"
    echo "  activity  - Recent messages"
    echo "  logs      - Follow logs in real-time"
    echo "  errors    - Show recent errors"
    echo ""
    echo "Examples:"
    echo "  $0 status"
    echo "  $0 logs | grep feishu"
    ;;
esac

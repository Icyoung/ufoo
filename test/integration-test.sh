#!/bin/bash
# 全面回归测试脚本
set -e

echo "========================================"
echo "  ufoo 迁移后全面回归测试"
echo "========================================"
echo

TEMP_PROJECT="/tmp/ufoo-test-$$"
TEST_SESSION="test-$(date +%s)"
ERRORS=0

trap 'rm -rf "$TEMP_PROJECT"' EXIT

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() {
  echo -e "${GREEN}✓${NC} $1"
}

fail() {
  echo -e "${RED}✗${NC} $1"
  ERRORS=$((ERRORS + 1))
}

info() {
  echo -e "${YELLOW}→${NC} $1"
}

section() {
  echo
  echo "----------------------------------------"
  echo "  $1"
  echo "----------------------------------------"
}

# 测试 1: 初始化功能
section "测试 1: 初始化功能"

info "创建临时项目目录"
mkdir -p "$TEMP_PROJECT"
cd "$TEMP_PROJECT"

info "测试 ufoo init"
if node "$OLDPWD/bin/ufoo.js" init --modules "context,bus" --project "$TEMP_PROJECT" >/dev/null 2>&1; then
  pass "ufoo init 成功"
else
  fail "ufoo init 失败"
fi

info "验证目录结构"
if [[ -d ".ufoo/bus" && -d ".ufoo/context" ]]; then
  pass "目录结构正确"
else
  fail "目录结构不正确"
fi

if [[ -f ".ufoo/bus/bus.json" ]]; then
  pass "bus.json 创建成功"
else
  fail "bus.json 未创建"
fi

# 测试 2: EventBus 核心功能
section "测试 2: EventBus 核心功能"

info "测试 bus join"
if node "$OLDPWD/bin/ufoo.js" bus join "$TEST_SESSION" "claude-code" >/dev/null 2>&1; then
  pass "bus join 成功"
else
  fail "bus join 失败"
fi

info "验证订阅者注册"
SUBSCRIBER="claude-code:$TEST_SESSION"
if grep -q "$SUBSCRIBER" ".ufoo/bus/bus.json"; then
  pass "订阅者已注册"
else
  fail "订阅者未注册"
fi

info "测试 bus status"
if node "$OLDPWD/bin/ufoo.js" bus status >/dev/null 2>&1; then
  pass "bus status 成功"
else
  fail "bus status 失败"
fi

info "测试 bus send"
if AI_BUS_PUBLISHER="test-sender" node "$OLDPWD/bin/ufoo.js" bus send "$SUBSCRIBER" "Test message" >/dev/null 2>&1; then
  pass "bus send 成功"
else
  fail "bus send 失败"
fi

info "测试 bus check"
if node "$OLDPWD/bin/ufoo.js" bus check "$SUBSCRIBER" 2>&1 | grep -q "Test message"; then
  pass "bus check 成功（消息已接收）"
else
  fail "bus check 失败（消息未接收）"
fi

info "测试 bus ack"
if node "$OLDPWD/bin/ufoo.js" bus ack "$SUBSCRIBER" >/dev/null 2>&1; then
  pass "bus ack 成功"
else
  fail "bus ack 失败"
fi

info "验证消息已清空"
if node "$OLDPWD/bin/ufoo.js" bus check "$SUBSCRIBER" 2>&1 | grep -q "No pending messages"; then
  pass "消息已清空"
else
  fail "消息未清空"
fi

# 测试 3: 昵称功能
section "测试 3: 昵称功能"

info "测试 bus rename"
if node "$OLDPWD/bin/ufoo.js" bus rename "$SUBSCRIBER" "test-agent" >/dev/null 2>&1; then
  pass "bus rename 成功"
else
  fail "bus rename 失败"
fi

info "验证昵称已更新"
if grep -q '"test-agent"' ".ufoo/bus/bus.json"; then
  pass "昵称已更新"
else
  fail "昵称未更新"
fi

info "测试通过昵称发送消息"
if AI_BUS_PUBLISHER="test-sender" node "$OLDPWD/bin/ufoo.js" bus send "test-agent" "Test via nickname" >/dev/null 2>&1; then
  pass "通过昵称发送成功"
else
  fail "通过昵称发送失败"
fi

# 测试 4: 广播功能
section "测试 4: 广播功能"

info "测试 bus broadcast"
if AI_BUS_PUBLISHER="test-sender" node "$OLDPWD/bin/ufoo.js" bus broadcast "Broadcast message" >/dev/null 2>&1; then
  pass "bus broadcast 成功"
else
  fail "bus broadcast 失败"
fi

info "清空待处理消息"
node "$OLDPWD/bin/ufoo.js" bus ack "$SUBSCRIBER" >/dev/null 2>&1

# 测试 5: Resolve 功能
section "测试 5: Resolve 功能"

info "测试 bus resolve"
if node "$OLDPWD/bin/ufoo.js" bus resolve "$SUBSCRIBER" "claude" >/dev/null 2>&1; then
  pass "bus resolve 成功"
else
  fail "bus resolve 失败"
fi

# 测试 6: Skills 功能
section "测试 6: Skills 功能"

cd "$OLDPWD"

info "测试 skills list"
SKILLS_COUNT=$(node bin/ufoo.js skills list 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SKILLS_COUNT" -gt 0 ]]; then
  pass "skills list 成功（找到 $SKILLS_COUNT 个技能）"
else
  fail "skills list 失败"
fi

# 测试 7: Status 功能
section "测试 7: Status 功能"

info "测试 status 命令"
if node bin/ufoo.js status >/dev/null 2>&1; then
  pass "status 命令成功"
else
  fail "status 命令失败"
fi

# 测试 8: 性能测试
section "测试 8: 性能测试"

cd "$TEMP_PROJECT"

info "测试消息发送性能（100次）"
START=$(date +%s%N)
for i in {1..100}; do
  AI_BUS_PUBLISHER="perf-test" node "$OLDPWD/bin/ufoo.js" bus send "$SUBSCRIBER" "Perf test $i" >/dev/null 2>&1
done
END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 ))
AVG=$(( DURATION / 100 ))

if [[ $AVG -lt 100 ]]; then
  pass "性能测试通过（平均 ${AVG}ms/消息）"
else
  fail "性能测试失败（平均 ${AVG}ms/消息，目标 <100ms）"
fi

info "清空性能测试消息"
node "$OLDPWD/bin/ufoo.js" bus ack "$SUBSCRIBER" >/dev/null 2>&1

# 测试 9: 并发安全性
section "测试 9: 并发安全性"

info "测试并发消息发送（10个并发进程）"
for i in {1..10}; do
  (
    for j in {1..10}; do
      AI_BUS_PUBLISHER="concurrent-$i" node "$OLDPWD/bin/ufoo.js" bus send "$SUBSCRIBER" "Concurrent $i-$j" >/dev/null 2>&1
    done
  ) &
done
wait

info "验证消息完整性"
MSG_COUNT=$(node "$OLDPWD/bin/ufoo.js" bus check "$SUBSCRIBER" 2>&1 | grep -c "Concurrent" || echo "0")
if [[ $MSG_COUNT -eq 100 ]]; then
  pass "并发测试通过（100/100 消息完整）"
else
  fail "并发测试失败（$MSG_COUNT/100 消息）"
fi

# 测试 10: 清理
section "测试 10: 清理测试"

info "测试 bus leave"
if node "$OLDPWD/bin/ufoo.js" bus leave "$SUBSCRIBER" >/dev/null 2>&1; then
  pass "bus leave 成功"
else
  fail "bus leave 失败"
fi

# 最终结果
echo
echo "========================================"
if [[ $ERRORS -eq 0 ]]; then
  echo -e "${GREEN}✓ 所有测试通过！${NC}"
  echo "========================================"
  exit 0
else
  echo -e "${RED}✗ $ERRORS 个测试失败${NC}"
  echo "========================================"
  exit 1
fi

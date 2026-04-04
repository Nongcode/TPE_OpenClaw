import asyncio
import os
from browser_use import Agent, Browser, ChatOpenAI

# 1. Hàm lõi bất đồng bộ thực thi tác vụ duyệt web
async def _execute_browser_task(task_description: str) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("OPENAI_BASE_URL")

    if not api_key:
        raise RuntimeError("Thiếu OPENAI_API_KEY trong environment.")

    llm = ChatOpenAI(
        model=os.getenv("BROWSER_SKILL_MODEL", "gpt-4o"),
        api_key=api_key,
        base_url=base_url if base_url else None,
    )

    browser = Browser()

    try:
        agent = Agent(
            task=task_description,
            llm=llm,
            browser=browser,
        )

        result = await agent.run()
        return str(result)
    finally:
        await browser.close()

# 2. Hàm giao tiếp với OpenClaw
def openclaw_browser_skill(task_description: str) -> str:
    """
    Kỹ năng điều khiển trình duyệt web.
    Sử dụng kỹ năng này khi cần truy cập internet, tìm kiếm thông tin,
    hoặc tương tác với các hệ thống web nội bộ để trích xuất dữ liệu.
    """
    print(f"\n[Browser Skill] Đang thực thi nhiệm vụ: {task_description}")

    try:
        final_result = asyncio.run(_execute_browser_task(task_description))
        return final_result
    except Exception as e:
        return f"Quá trình duyệt web gặp lỗi: {str(e)}"


if __name__ == "__main__":
    import json
    import sys

    raw = sys.argv[1] if len(sys.argv) > 1 else "{}"
    payload = json.loads(raw)
    task = payload.get("task", "").strip()

    if not task:
        print('{"success": false, "error": "Missing task"}')
        raise SystemExit(1)

    try:
        result = asyncio.run(_execute_browser_task(task))
        print(result)
    except Exception as e:
        print(f'{{"success": false, "error": "{str(e)}"}}')
        raise SystemExit(1)

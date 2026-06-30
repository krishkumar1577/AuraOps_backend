"""Entry fixture: project with only agent.py — main.py does NOT exist.
This is the regression case the bugfix targets.
"""
from langchain.agents import AgentExecutor
from langchain.llms import OpenAI

def run():
    llm = OpenAI()
    return llm("hello")

if __name__ == "__main__":
    run()

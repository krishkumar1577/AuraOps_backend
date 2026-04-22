.PHONY: help install build test dev lint type-check clean start

# AuraOps Backend Makefile

help:
	@echo "AuraOps Backend - Available Commands"
	@echo "====================================="
	@echo ""
	@echo "Setup:"
	@echo "  make install        Install dependencies"
	@echo "  make build          Build TypeScript"
	@echo ""
	@echo "Development:"
	@echo "  make dev            Start dev server"
	@echo "  make test           Run tests"
	@echo "  make test-watch     Run tests in watch mode"
	@echo ""
	@echo "Code Quality:"
	@echo "  make lint           Check code style"
	@echo "  make type-check     Check TypeScript types"
	@echo "  make clean          Remove build artifacts"
	@echo ""
	@echo "Production:"
	@echo "  make start          Start production server"
	@echo ""

install:
	npm install

build:
	npm run build

test:
	npm test

test-watch:
	npm test:watch

dev:
	npm run dev

lint:
	npm run lint

type-check:
	npm run type-check

clean:
	rm -rf dist
	rm -rf node_modules/.cache
	npm cache clean --force

start: build
	npm start

.DEFAULT_GOAL := help

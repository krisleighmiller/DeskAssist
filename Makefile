.PHONY: lint lint\:py lint\:ts deadcode deadcode\:py deadcode\:ts

PYTHON ?= python

lint: lint\:py lint\:ts

lint\:py:
	$(PYTHON) -m ruff check .

lint\:ts:
	cd ui-electron && npm run lint

deadcode: deadcode\:py deadcode\:ts

deadcode\:py:
	$(PYTHON) -m vulture

deadcode\:ts:
	cd ui-electron && npm run deadcode:ts

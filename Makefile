.DEFAULT_GOAL := help
CASE ?=
APP  ?=
ARTIFACT ?=

help: ## show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

env-check: ## report which RE tools are installed
	@./scripts/env-setup.sh --check

env-install: ## install what can be installed (python tools + jadx/apktool)
	@./scripts/env-setup.sh --install

new: ## make new APP="Some App" [ARTIFACT=path/to.apk]
	@test -n "$(APP)" || { echo 'usage: make new APP="Some App" [ARTIFACT=app.apk]'; exit 2; }
	@./scripts/rekit new "$(APP)" $(if $(ARTIFACT),--artifact $(ARTIFACT),)

list: ## list cases
	@./scripts/rekit list

check: ## make check CASE=app-slug
	@test -n "$(CASE)" || { echo 'usage: make check CASE=app-slug'; exit 2; }
	@./scripts/rekit check $(CASE)

identify: ## make identify ARTIFACT=app.apk
	@test -n "$(ARTIFACT)" || { echo 'usage: make identify ARTIFACT=app.apk'; exit 2; }
	@python3 scripts/identify.py $(ARTIFACT)

scan: ## make scan CASE=app-slug (scan extracted/ into 02-surface-map.md)
	@test -n "$(CASE)" || { echo 'usage: make scan CASE=app-slug'; exit 2; }
	@python3 scripts/stringscan.py cases/$(CASE)/extracted -o cases/$(CASE)/02-surface-map.md

fixtures: ## make fixtures CASE=app-slug CAPTURE=captured/session.har
	@test -n "$(CASE)" || { echo 'usage: make fixtures CASE=app-slug CAPTURE=captured/session.har'; exit 2; }
	@python3 scripts/har2fixtures.py cases/$(CASE)/$(CAPTURE) -o cases/$(CASE)/mocks \
	  --surface cases/$(CASE)/03-api-surface.yaml --redact

test: ## run the built-in self-test on the scripts
	@python3 scripts/selftest.py

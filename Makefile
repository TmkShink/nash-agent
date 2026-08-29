.PHONY: build test vet fmt check

build:
	go build -o bin/nash ./cmd/nash

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w $$(find . -name '*.go' -not -path './.git/*')

check: test vet


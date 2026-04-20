from assistant_app.main import main


def test_smoke_runs(capsys):
    main()
    out = capsys.readouterr().out
    assert "bootstrap OK" in out
    assert "openai" in out
    assert "anthropic" in out
    assert "deepseek" in out


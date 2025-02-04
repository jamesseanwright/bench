import { join, parse, stringify } from "./deps.ts";

import type { Action, Benchmark, Config, Group, Job, Step } from "./types.ts";

function command(result: string, exe: string): string {
  return `${exe} &
sleep 15 && 
mkdir -p results &&
autocannon -c 40 -d 10 -j http://localhost:8000 > results/${result}.json &&
kill $!`;
}

function wrap(
  step: Step,
  benchmark: Benchmark,
  group: Group,
): Step[] {
  const deno: Step = {
    name: "Setup deno latest",
    uses: "denoland/setup-deno@main",
  };
  if (benchmark.version) {
    deno.name = `Setup deno ${benchmark.version}`;
    deno.with = { ["deno-version"]: benchmark.version };
  }

  return [
    {
      name: "Checkout Repository",
      uses: "actions/checkout@master",
      with: { "persist-credentials": false, "fetch-depth": 0 },
    },
    { name: "Pull changes from other benchmarks", run: "git pull" },
    {
      name: "Setup nodejs 13",
      uses: "actions/setup-node@v1",
      with: { "node-version": "13" },
    },
    { ...deno },
    { name: "Install Autocannon", run: "npm install -g autocannon" },
    { name: "START", run: 'echo "Starting Benchmarks"' },
    step,
    { name: "END", run: 'echo "End Benchmarks"' },
    //{
    //  name: "Pull latest commits",
    //  run: "git pull",
    //},
    //{
    //  name: "Commit & Push changes",
    //  uses: "actions-js/push@master",
    //  with: {
    //    github_token: "${{ secrets.GITHUB_TOKEN }}",
    //    coauthor_email: "filipporeds@users.noreply.github.com",
    //    coauthor_name: "filipporeds",
    //    branch: "main",
    //  },
    //},
    {
      name: "Set result output",
      id: "result",
      run:
        `RESULT_DIR="${benchmark.dir}/results/"
RESULT_PATH="${benchmark.dir}/results/${group.name}_${benchmark.name}.json"
RESULT="$(cat ${benchmark.dir}/results/${group.name}_${benchmark.name}.json)"
echo "::set-output name=result_dir::$RESULT_DIR"
echo "::set-output name=result_path::$RESULT_PATH"
echo "::set-output name=result::$RESULT"
`,
    },
  ];
}

function generateResults(previous: string[]): Job {
  const steps: Step[] = [];

  for (const step of previous) {
    steps.push({
      name: `Save ${step} results`,
      run:
        `mkdir -p \${{needs.${step}.outputs.result_dir}}
echo '\${{needs.${step}.outputs.result}}' | tee \${{needs.${step}.outputs.result_path}}
`,
    });
  }

  return {
    "runs-on": "ubuntu-latest",
    needs: [...previous],
    steps: [
      {
        name: "Checkout Repository",
        uses: "actions/checkout@master",
        with: { "persist-credentials": false, "fetch-depth": 0 },
      },
      // { name: "Pull changes from other benchmarks", run: "git pull" },
      ...steps,
      {
        name: "Setup deno 1.x",
        uses: "denoland/setup-deno@main",
      },
      {
        name: "Generate README.md",
        run: "deno run -A --unstable _bench/readme.ts",
      },
      {
        name: "Commit & Push changes",
        uses: "actions-js/push@master",
        with: {
          github_token: "${{ secrets.GITHUB_TOKEN }}",
          coauthor_email: "qu4k@users.noreply.github.com",
          coauthor_name: "qu4k",
          branch: "main",
        },
      },
    ],
  };
}

if (import.meta.main) {
  const configPath = "benchmarks.yml";
  const actionPath = join(".github", "workflows", "bench.yml");

  const actionSource = await Deno.readTextFile(actionPath);
  const action = parse(actionSource) as Action;
  action.jobs = {};

  const configSource = await Deno.readTextFile(configPath);
  const config = parse(configSource) as Config;

  const previous = [];

  for (const group of config.groups) {
    for (const benchmark of group.benchmarks) {
      const name = `${group.name}_${benchmark.name}`;
      const test: Step = {
        name: benchmark.name,
        run: command(name, benchmark.exe),
        "working-directory": benchmark.dir,
        "continue-on-error": true,
      };

      if (benchmark.env) {
        test.env = benchmark.env;
      }

      const steps = wrap(test, benchmark, group);
      action.jobs[name] = {
        "runs-on": "ubuntu-latest",
        // needs: [...previous],
        outputs: {
          "result_dir": "${{ steps.result.outputs.result_dir }}",
          "result_path": "${{ steps.result.outputs.result_path }}",
          "result": "${{ steps.result.outputs.result }}",
        },
        steps,
      };
      previous.push(name);
    }
  }

  action.jobs["_results"] = generateResults(previous);

  await Deno.writeTextFile(actionPath, stringify(action));
}

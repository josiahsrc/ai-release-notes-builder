const core = require('@actions/core');
const { execSync } = require('child_process');

const MODELS_ENDPOINT = 'https://models.github.ai/inference/chat/completions';
const DEFAULT_SYSTEM_PROMPT =
  'You are an expert technical writer who creates clear, concise, and actionable release notes for software changes.';

function runCommand(command, options = {}) {
  core.debug(`Executing: ${command}`);
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function resolveCommit(ref) {
  try {
    return runCommand(`git rev-parse ${ref}`).trim();
  } catch (error) {
    throw new Error(`Failed to resolve commit reference "${ref}": ${error.message}`);
  }
}

function listCommitsInRange(fromSha, toSha) {
  try {
    const output = runCommand(`git rev-list --reverse ${fromSha}..${toSha}`).trim();
    if (!output) {
      return [];
    }
    return output.split('\n').filter(Boolean);
  } catch (error) {
    throw new Error(`Failed to list commits between ${fromSha} and ${toSha}: ${error.message}`);
  }
}

function readCommitTitle(sha) {
  return runCommand(`git show -s --format=%s ${sha}`).trim();
}

function readCommitBody(sha) {
  return runCommand(`git show -s --format=%b ${sha}`).trim();
}

function readCommitDiff(sha) {
  return runCommand(`git show ${sha} --format=`); // Do not trim; diff formatting matters.
}

function truncateContent(content, limit) {
  if (!limit || limit <= 0) {
    return { text: content, truncated: false };
  }

  if (content.length <= limit) {
    return { text: content, truncated: false };
  }

  const sliced = content.slice(0, limit);
  const text = `${sliced}\n\n[Diff truncated to the first ${limit} characters]`;
  return { text, truncated: true };
}

function buildCommitSection(commit, maxDiffChars) {
  const title = readCommitTitle(commit);
  const body = readCommitBody(commit);
  const diff = readCommitDiff(commit);
  const truncated = truncateContent(diff, maxDiffChars);

  const sectionParts = [
    `Commit: ${title}`,
    `SHA: ${commit}`,
  ];

  if (body) {
    sectionParts.push(`Body:\n${body}`);
  }

  sectionParts.push(`Diff:\n${truncated.text}`);

  return sectionParts.join('\n\n');
}

async function callModel({ token, model, temperature, maxTokens, systemPrompt, prompt }) {
  const response = await fetch(MODELS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model request failed with status ${response.status}: ${text}`);
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  const content = choice?.message?.content;

  if (!content) {
    throw new Error('Model response did not include any content.');
  }

  return content.trim();
}

async function run() {
  try {
    const startRef = core.getInput('from', { required: true }).trim();
    const endRefInput = core.getInput('to').trim();
    const includeStartCommit = core.getBooleanInput('include_start_commit');
    const model = core.getInput('model') || 'openai/gpt-4o-mini';
    const maxDiffCharsInput = core.getInput('max_diff_chars') || '6000';
    const maxOutputTokensInput = core.getInput('max_output_tokens') || '800';
    const temperatureInput = core.getInput('temperature') || '0.2';
    const systemPrompt = core.getInput('system_prompt') || DEFAULT_SYSTEM_PROMPT;
    const extraInstructions = core.getInput('extra_instructions');
    const customPrompt = core.getInput('prompt');
    const githubToken = process.env.GITHUB_TOKEN;

    if (!githubToken) {
      throw new Error('GITHUB_TOKEN environment variable is required to call GitHub Models API.');
    }

    const maxDiffChars = Number.parseInt(maxDiffCharsInput, 10);
    if (Number.isNaN(maxDiffChars) || maxDiffChars <= 0) {
      throw new Error(`"max_diff_chars" must be a positive integer. Received "${maxDiffCharsInput}".`);
    }

    const maxOutputTokens = Number.parseInt(maxOutputTokensInput, 10);
    if (Number.isNaN(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new Error(`"max_output_tokens" must be a positive integer. Received "${maxOutputTokensInput}".`);
    }

    const temperature = Number.parseFloat(temperatureInput);
    if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) {
      throw new Error(`"temperature" must be a number between 0 and 2. Received "${temperatureInput}".`);
    }

    const endRef = endRefInput || 'HEAD';

    const fromSha = resolveCommit(startRef);
    const toSha = resolveCommit(endRef);

    const commitsInRange = listCommitsInRange(fromSha, toSha);
    const commitOrder = includeStartCommit ? [fromSha, ...commitsInRange] : commitsInRange;

    if (commitOrder.length === 0) {
      core.notice(`No commits found between ${fromSha} and ${toSha}.`);
      core.setOutput('release-notes', '');
      return;
    }

    const commitSections = commitOrder.map((sha, index) => {
      core.info(`Collecting details for commit ${index + 1}/${commitOrder.length}: ${sha}`);
      return buildCommitSection(sha, maxDiffChars);
    });

    const promptParts = [];

    if (customPrompt) {
      promptParts.push(customPrompt);
    } else {
      promptParts.push(
        `Generate release notes for ${commitOrder.length} commit(s) from ${fromSha} to ${toSha}.`,
        'Focus on user-facing changes, notable technical improvements, and breaking changes.',
        'Provide Markdown formatted output with clear bullet points or sections.'
      );
    }

    if (extraInstructions) {
      promptParts.push(`Additional guidance: ${extraInstructions}`);
    }

    promptParts.push('Commit details:');
    promptParts.push(commitSections.join('\n\n---\n\n'));

    const prompt = promptParts.join('\n\n');

    core.info(`Requesting release notes from model "${model}"...`);
    const releaseNotes = await callModel({
      token: githubToken,
      model,
      temperature,
      maxTokens: maxOutputTokens,
      systemPrompt,
      prompt,
    });

    core.setOutput('release-notes', releaseNotes);
    await core.summary.addRaw(`## AI Generated Release Notes\n\n${releaseNotes}`).write();
    core.info('Release notes generated successfully.');
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();

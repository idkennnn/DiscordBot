require('dotenv').config();

const { spawn } = require('node:child_process');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const PREFIX = '$';
const guildMusic = new Map();

client.once(Events.ClientReady, readyClient => {
  console.log(`Bot listo: ${readyClient.user.tag}`);
});

function getGuildState(guildId) {
  if (!guildMusic.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    const state = {
      player,
      queue: [],
      current: null,
      ffmpeg: null,
      isPlaying: false,
    };

    player.on('error', error => {
      console.error(`Error del reproductor en guild ${guildId}:`, error.message);
      state.isPlaying = false;
      playNext(guildId).catch(console.error);
    });

    player.on(AudioPlayerStatus.Idle, () => {
      if (state.ffmpeg) {
        state.ffmpeg.kill('SIGKILL');
        state.ffmpeg = null;
      }

      if (state.current) {
        console.log(`Terminó: ${state.current.title}`);
      }

      state.current = null;
      state.isPlaying = false;

      playNext(guildId).catch(console.error);
    });

    guildMusic.set(guildId, state);
  }

  return guildMusic.get(guildId);
}

async function connectToVoice(channel) {
  let connection = getVoiceConnection(channel.guild.id);

  if (connection && connection.joinConfig.channelId === channel.id) {
    return connection;
  }

  if (connection) {
    connection.destroy();
  }

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  return connection;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('error', reject);

    proc.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `${command} terminó con código ${code}`));
      }
    });
  });
}

async function getAudioUrl(query) {
  const isUrl = query.startsWith('http://') || query.startsWith('https://');
  const target = isUrl ? query : `ytsearch1:${query}`;

  const url = await runCommand('yt-dlp', [
    '-f', 'bestaudio',
    '--no-playlist',
    '--get-url',
    target,
  ]);

  if (!url) {
    throw new Error('yt-dlp no devolvió URL de audio');
  }

  return url.split('\n')[0].trim();
}

function createFFmpegResource(audioUrl, guildId) {
  const state = getGuildState(guildId);

  if (state.ffmpeg) {
    state.ffmpeg.kill('SIGKILL');
    state.ffmpeg = null;
  }

  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', audioUrl,
    '-analyzeduration', '0',
    '-loglevel', '0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  ffmpeg.stderr.on('data', data => {
    const msg = data.toString().trim();
    if (msg) console.error('ffmpeg:', msg);
  });

  ffmpeg.on('close', code => {
    console.log(`ffmpeg cerrado en guild ${guildId} con código ${code}`);
    if (state.ffmpeg === ffmpeg) {
      state.ffmpeg = null;
    }
  });

  state.ffmpeg = ffmpeg;

  return createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
  });
}

async function playNext(guildId) {
  const state = getGuildState(guildId);
  const connection = getVoiceConnection(guildId);

  if (!connection) {
    state.queue = [];
    state.current = null;
    state.isPlaying = false;
    return;
  }

  if (state.queue.length === 0) {
    state.current = null;
    state.isPlaying = false;
    return;
  }

  const nextSong = state.queue.shift();
  state.current = nextSong;
  state.isPlaying = true;

  try {
    const audioUrl = await getAudioUrl(nextSong.query);
    const resource = createFFmpegResource(audioUrl, guildId);

    connection.subscribe(state.player);
    state.player.play(resource);

    console.log(`Reproduciendo ahora: ${nextSong.title}`);
    await nextSong.textChannel.send(`Reproduciendo 🎶: **${nextSong.title}**`);
  } catch (error) {
    console.error('Error reproduciendo siguiente canción:', error);
    state.current = null;
    state.isPlaying = false;
    await nextSong.textChannel.send(`No pude reproducir: **${nextSong.title}**`);
    await playNext(guildId);
  }
}

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift()?.toLowerCase();

  if (!command) return;

  const guildId = message.guild.id;
  const state = getGuildState(guildId);

  if (command === 'ping') {
    return await message.reply('pong');
  }

  if (command === 'join') {
    const channel = message.member?.voice?.channel;

    if (!channel) {
      return await message.reply('Debes estar en un canal de voz 😪');
    }

    try {
      await connectToVoice(channel);
      return await message.reply(`Me uní a **${channel.name}**`);
    } catch (error) {
      console.error('Error al conectar:', error);
      return await message.reply('No pude conectarme al canal de voz.');
    }
  }

  if (command === 'leave') {
    const connection = getVoiceConnection(guildId);

    state.player.stop();
    state.queue = [];
    state.current = null;
    state.isPlaying = false;

    if (state.ffmpeg) {
      state.ffmpeg.kill('SIGKILL');
      state.ffmpeg = null;
    }

    if (!connection) {
      return await message.reply('No estoy en un canal de voz.');
    }

    connection.destroy();
    return await message.reply('Salí del canal de voz.');
  }

  if (command === 'play') {
    const query = args.join(' ');
    const channel = message.member?.voice?.channel;

    if (!channel) {
      return await message.reply('Debes estar en un canal de voz 😪');
    }

    if (!query) {
      return await message.reply('Debes escribir algo para reproducir.');
    }

    try {
      await connectToVoice(channel);

      const song = {
        query,
        title: query,
        requestedBy: message.author.username,
        textChannel: message.channel,
      };

      state.queue.push(song);

      if (state.current || state.isPlaying) {
        return await message.reply(`Agregado a la cola ✅: **${song.title}**`);
      }

      await message.reply(`Agregado a la cola ✅: **${song.title}**`);
      await playNext(guildId);
    } catch (error) {
      console.error('Error en play:', error);
      return await message.reply('No pude agregar esa canción.');
    }
  }

  if (command === 'queue') {
    const lines = [];

    if (state.current) {
      lines.push(`**Ahora:** ${state.current.title}`);
    }

    if (state.queue.length > 0) {
      const nextSongs = state.queue
        .slice(0, 10)
        .map((song, index) => `${index + 1}. ${song.title}`);
      lines.push(`**En cola:**\n${nextSongs.join('\n')}`);
    }

    if (!state.current && state.queue.length === 0) {
      return await message.reply('La cola está vacía.');
    }

    return await message.reply(lines.join('\n\n'));
  }

  if (command === 'skip') {
    if (!state.current) {
      return await message.reply('No hay canción actual para saltar.');
    }

    state.player.stop();
    return await message.reply(`Saltando ⏭️: **${state.current.title}**`);
  }

  if (command === 'stop') {
    state.queue = [];

    if (state.ffmpeg) {
      state.ffmpeg.kill('SIGKILL');
      state.ffmpeg = null;
    }

    state.player.stop();
    state.current = null;
    state.isPlaying = false;

    return await message.reply('Detenido y cola limpiada.');
  }

  if (command === 'pause') {
    if (!state.current) {
      return await message.reply('No hay reproducción activa.');
    }

    state.player.pause();
    return await message.reply('Pausado.');
  }

  if (command === 'resume') {
    if (!state.current) {
      return await message.reply('No hay reproducción activa.');
    }

    state.player.unpause();
    return await message.reply('Reanudado.');
  }
});

client.login(process.env.TOKEN);
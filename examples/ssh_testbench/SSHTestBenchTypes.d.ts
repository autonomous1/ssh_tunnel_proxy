export type TestConfig = {
    port: number;
    host?: string;
    name: string;
}

export type LinkConfig = {
    server: string;
    client: string;
    dest: string;
}

export type SSHServerConfig = {
    port: number;
    host: string;
    hostkeys: Array<string>;
}

export type SSHClientConfig = {
    name: string;
    username: string;
    host?: string;
    port?: number;
    key: string;
}

export type SSHTestBenchConfig = {
    sshServer: SSHServerConfig;
    sshClient: SSHClientConfig;
    server: Array<TestConfig>;
    client: Array<TestConfig>;
    link: Array<LinkConfig>;
}
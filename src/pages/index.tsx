import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import {useLanding} from '@site/src/data/site';
import {useReveal} from '@site/src/hooks/useReveal';
import {Contact} from '@site/src/components/portfolio/Contact';
import {Credentials} from '@site/src/components/portfolio/Credentials';
import {Hero} from '@site/src/components/portfolio/Hero';
import {History} from '@site/src/components/portfolio/History';
import {Impact} from '@site/src/components/portfolio/Impact';
import {Shipped} from '@site/src/components/portfolio/Shipped';
import {Stack} from '@site/src/components/portfolio/Stack';

export default function Home(): ReactNode {
  const profile = useLanding();
  useReveal();

  return (
    <Layout description={profile.summary} title={profile.headline}>
      <Hero profile={profile} />
      <main>
        <Impact profile={profile} />
        <History profile={profile} />
        <Stack profile={profile} />
        <Shipped profile={profile} />
        <Credentials profile={profile} />
      </main>
      <Contact profile={profile} />
    </Layout>
  );
}
